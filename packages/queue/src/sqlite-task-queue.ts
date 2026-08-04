import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

export const queueItemStatusSchema = z.enum([
  'queued',
  'processing',
  'acknowledged',
  'retrying',
  'dead_letter',
]);

export type QueueItemStatus = z.infer<typeof queueItemStatusSchema>;

export interface EnqueueItem {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface QueueItem<T = unknown> {
  readonly id: string;
  readonly kind: string;
  readonly payload: T;
  readonly status: QueueItemStatus;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const storedItemSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  payload: z.unknown(),
  status: queueItemStatusSchema,
  attempts: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const queueFileSchema = z.object({
  version: z.literal(1),
  items: z.array(storedItemSchema),
});

type StoredItem = z.infer<typeof storedItemSchema>;

const COMPLETED_RETENTION_MS = 10 * 60_000;
const MAX_COMPLETED_ITEMS = 1_000;

/**
 * Small JSON-backed queue for the node processes.
 *
 * The project intentionally keeps runtime state as readable files. The old
 * class name is exported below as a compatibility alias for existing imports.
 */
export class FileTaskQueue {
  readonly #path: string;
  readonly #items = new Map<string, StoredItem>();

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.#load();
  }

  enqueue(item: EnqueueItem): boolean {
    if (this.#items.has(item.id)) return false;
    const now = new Date().toISOString();
    this.#items.set(item.id, {
      id: item.id,
      kind: item.kind,
      payload: item.payload,
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.#flush();
    return true;
  }

  get<T = unknown>(id: string): QueueItem<T> | undefined {
    const item = this.#items.get(id);
    return item ? this.#mapItem<T>(item) : undefined;
  }

  updatePayload<T>(id: string, payload: T): void {
    const current = this.#items.get(id);
    if (!current) throw new Error(`Queue item ${id} does not exist.`);
    this.#items.set(id, {
      ...current,
      payload,
      updatedAt: new Date().toISOString(),
    });
    this.#flush();
  }

  listRecoverable<T = unknown>(limit = 100): QueueItem<T>[] {
    const safeLimit = z.number().int().positive().max(10_000).parse(limit);
    return [...this.#items.values()]
      .filter((item) => ['queued', 'processing', 'retrying'].includes(item.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, safeLimit)
      .map((item) => this.#mapItem<T>(item));
  }

  markProcessing(id: string): void {
    this.#transition(id, ['queued', 'retrying'], 'processing', true);
  }

  markAcknowledged(id: string): void {
    this.#transition(id, ['processing'], 'acknowledged', false);
  }

  markRetrying(id: string): void {
    this.#transition(id, ['processing'], 'retrying', false);
  }

  markDeadLetter(id: string): void {
    this.#transition(id, ['queued', 'processing', 'retrying'], 'dead_letter', false);
  }

  close(): void {
    this.#flush();
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    try {
      const parsed = queueFileSchema.parse(JSON.parse(readFileSync(this.#path, 'utf8')));
      for (const item of parsed.items) this.#items.set(item.id, item);
    } catch (error) {
      // A previous release called this file `queue.sqlite` even though it was
      // JSON.  Preserve the damaged/legacy file and start with an empty queue
      // instead of crashing the whole node before it can reconnect.
      const backupPath = `${this.#path}.invalid-${Date.now()}`;
      try {
        renameSync(this.#path, backupPath);
      } catch {
        // If the backup cannot be created, the next enqueue will still try to
        // replace the file atomically; keep startup alive and report the path.
      }
      console.error(
        `[DisQord/Queue] invalid queue file moved to ${backupPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  #flush(): void {
    this.#pruneCompleted();
    const temporaryPath = `${this.#path}.tmp`;
    writeFileSync(
      temporaryPath,
      JSON.stringify({ version: 1, items: [...this.#items.values()] }, null, 2),
      'utf8',
    );
    renameSync(temporaryPath, this.#path);
  }

  #pruneCompleted(): void {
    const now = Date.now();
    const completed = [...this.#items.values()]
      .filter((item) => item.status === 'acknowledged' || item.status === 'dead_letter')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const removable = new Set(
      completed
        .filter((item) => now - Date.parse(item.updatedAt) > COMPLETED_RETENTION_MS)
        .map((item) => item.id),
    );
    if (completed.length - removable.size > MAX_COMPLETED_ITEMS) {
      for (const item of completed) {
        if (completed.length - removable.size <= MAX_COMPLETED_ITEMS) break;
        removable.add(item.id);
      }
    }
    for (const id of removable) this.#items.delete(id);
  }

  #transition(
    id: string,
    from: readonly QueueItemStatus[],
    to: QueueItemStatus,
    incrementAttempts: boolean,
  ): void {
    const current = this.#items.get(id);
    if (!current || !from.includes(current.status)) {
      throw new Error(`Queue item ${id} cannot transition to ${to}.`);
    }
    this.#items.set(id, {
      ...current,
      status: to,
      attempts: incrementAttempts ? current.attempts + 1 : current.attempts,
      updatedAt: new Date().toISOString(),
    });
    this.#flush();
  }

  #mapItem<T>(item: StoredItem): QueueItem<T> {
    return {
      id: item.id,
      kind: item.kind,
      payload: item.payload as T,
      status: item.status,
      attempts: item.attempts,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}

/** @deprecated Use FileTaskQueue. Kept for source compatibility. */
export class SqliteTaskQueue extends FileTaskQueue {}
