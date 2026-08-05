import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

export const nodeLogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type NodeLogLevel = z.infer<typeof nodeLogLevelSchema>;

export interface NodeLogRecord {
  readonly createdAt: string;
  readonly level: NodeLogLevel;
  readonly event: string;
  readonly details?: Record<string, unknown>;
}

export interface NodeLogQuery {
  readonly page?: number;
  readonly pageSize?: number;
  readonly level?: NodeLogLevel | 'all';
  /** Optional multi-level filter used by the central log proxy. */
  readonly levels?: readonly NodeLogLevel[];
  readonly search?: string;
}

export interface NodeLogPage {
  readonly items: NodeLogRecord[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_LINES = 20_000;
const MAX_READ_BYTES = 4 * 1024 * 1024;

export class NodeLogger {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  get path(): string {
    return this.#path;
  }

  write(level: NodeLogLevel, event: string, details?: Record<string, unknown>): void {
    const record: NodeLogRecord = {
      createdAt: new Date().toISOString(),
      level: nodeLogLevelSchema.parse(level),
      event,
      ...(details && Object.keys(details).length ? { details } : {}),
    };
    appendFileSync(this.#path, `${JSON.stringify(record)}\n`, 'utf8');
    this.#rotateIfNeeded();
  }

  list(query: NodeLogQuery = {}): NodeLogPage {
    const pageSize = Math.min(200, Math.max(10, Math.floor(query.pageSize ?? 50)));
    const requestedPage = Math.max(1, Math.floor(query.page ?? 1));
    const level = query.level ?? 'all';
    const search = query.search?.trim().toLocaleLowerCase() ?? '';
    let records = this.#read();
    if (level !== 'all') records = records.filter((record) => record.level === level);
    if (query.levels?.length) {
      const levels = new Set(query.levels);
      records = records.filter((record) => levels.has(record.level));
    }
    if (search) {
      records = records.filter((record) =>
        JSON.stringify(record).toLocaleLowerCase().includes(search),
      );
    }
    records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const total = records.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    return {
      items: records.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total,
      totalPages,
    };
  }

  #read(): NodeLogRecord[] {
    if (!existsSync(this.#path)) return [];
    return this.#readTail()
      .split(/\r?\n/u)
      .filter(Boolean)
      .slice(-MAX_LOG_LINES)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as NodeLogRecord;
          return nodeLogLevelSchema.safeParse(value.level).success &&
            typeof value.event === 'string'
            ? [value]
            : [];
        } catch {
          return [];
        }
      });
  }

  #readTail(): string {
    const stats = statSync(this.#path);
    if (stats.size <= MAX_READ_BYTES) return readFileSync(this.#path, 'utf8');
    const start = Math.max(0, stats.size - MAX_READ_BYTES);
    const descriptor = openSync(this.#path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(stats.size - start);
      const bytes = readSync(descriptor, buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, bytes).toString('utf8');
      const firstBreak = text.indexOf('\n');
      return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
    } finally {
      closeSync(descriptor);
    }
  }

  #rotateIfNeeded(): void {
    if (!existsSync(this.#path) || statSync(this.#path).size <= MAX_LOG_BYTES) return;
    const lines = readFileSync(this.#path, 'utf8').split(/\r?\n/u).filter(Boolean);
    const retained = lines.slice(-MAX_LOG_LINES);
    const temporaryPath = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, retained.length ? `${retained.join('\n')}\n` : '', 'utf8');
    renameSync(temporaryPath, this.#path);
  }
}
