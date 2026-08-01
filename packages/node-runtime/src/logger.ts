import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
  readonly search?: string;
}

export interface NodeLogPage {
  readonly items: NodeLogRecord[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

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
  }

  list(query: NodeLogQuery = {}): NodeLogPage {
    const pageSize = Math.min(200, Math.max(10, Math.floor(query.pageSize ?? 50)));
    const requestedPage = Math.max(1, Math.floor(query.page ?? 1));
    const level = query.level ?? 'all';
    const search = query.search?.trim().toLocaleLowerCase() ?? '';
    let records = this.#read();
    if (level !== 'all') records = records.filter((record) => record.level === level);
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
    return readFileSync(this.#path, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as NodeLogRecord;
          return nodeLogLevelSchema.safeParse(value.level).success && typeof value.event === 'string'
            ? [value]
            : [];
        } catch {
          return [];
        }
      });
  }
}
