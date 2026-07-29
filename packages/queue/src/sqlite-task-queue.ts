import { DatabaseSync } from 'node:sqlite';

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

interface QueueRow {
  id: string;
  kind: string;
  payload_json: string;
  status: string;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export class SqliteTaskQueue {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec('PRAGMA journal_mode = WAL;');
    this.#database.exec('PRAGMA foreign_keys = ON;');
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS queue_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queue_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'processing', 'acknowledged', 'retrying', 'dead_letter')
        ),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS queue_items_status_created_idx
      ON queue_items (status, created_at);

      INSERT OR IGNORE INTO queue_schema_migrations (version, applied_at)
      VALUES (1, datetime('now'));
    `);
  }

  enqueue(item: EnqueueItem): boolean {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `
          INSERT OR IGNORE INTO queue_items (
            id, kind, payload_json, status, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, 'queued', 0, ?, ?)
        `,
      )
      .run(item.id, item.kind, JSON.stringify(item.payload), now, now);

    return result.changes === 1;
  }

  get<T = unknown>(id: string): QueueItem<T> | undefined {
    const row = this.#database
      .prepare(
        `
          SELECT id, kind, payload_json, status, attempts, created_at, updated_at
          FROM queue_items
          WHERE id = ?
        `,
      )
      .get(id) as unknown as QueueRow | undefined;

    return row ? this.#mapRow<T>(row) : undefined;
  }

  listRecoverable<T = unknown>(limit = 100): QueueItem<T>[] {
    const safeLimit = z.number().int().positive().max(10_000).parse(limit);
    const rows = this.#database
      .prepare(
        `
          SELECT id, kind, payload_json, status, attempts, created_at, updated_at
          FROM queue_items
          WHERE status IN ('queued', 'processing', 'retrying')
          ORDER BY created_at ASC
          LIMIT ?
        `,
      )
      .all(safeLimit) as unknown as QueueRow[];

    return rows.map((row) => this.#mapRow<T>(row));
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
    this.#database.close();
  }

  #transition(
    id: string,
    from: readonly QueueItemStatus[],
    to: QueueItemStatus,
    incrementAttempts: boolean,
  ): void {
    const placeholders = from.map(() => '?').join(', ');
    const attemptSql = incrementAttempts ? 'attempts = attempts + 1,' : '';
    const result = this.#database
      .prepare(
        `
          UPDATE queue_items
          SET status = ?, ${attemptSql} updated_at = ?
          WHERE id = ? AND status IN (${placeholders})
        `,
      )
      .run(to, new Date().toISOString(), id, ...from);

    if (result.changes !== 1) {
      throw new Error(`Queue item ${id} cannot transition to ${to}.`);
    }
  }

  #mapRow<T>(row: QueueRow): QueueItem<T> {
    return {
      id: row.id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as T,
      status: queueItemStatusSchema.parse(row.status),
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
