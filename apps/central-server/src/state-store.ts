import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface StateEntry<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StateStore {
  get<T>(namespace: string, key: string): Promise<StateEntry<T> | undefined>;
  list<T>(namespace: string): Promise<readonly StateEntry<T>[]>;
  set<T>(namespace: string, key: string, value: T): Promise<StateEntry<T>>;
  delete(namespace: string, key: string): Promise<boolean>;
  /** Wait until accepted writes have crossed the store's durability boundary. */
  flush(): Promise<void>;
}

export class InMemoryStateStore implements StateStore {
  readonly #entries = new Map<string, StateEntry>();

  async get<T>(namespace: string, key: string): Promise<StateEntry<T> | undefined> {
    const entry = this.#entries.get(`${namespace}\u001f${key}`);
    return entry ? (structuredClone(entry) as StateEntry<T>) : undefined;
  }

  async list<T>(namespace: string): Promise<readonly StateEntry<T>[]> {
    const prefix = `${namespace}\u001f`;
    return [...this.#entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => structuredClone(value) as StateEntry<T>)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async set<T>(namespace: string, key: string, value: T): Promise<StateEntry<T>> {
    const composite = `${namespace}\u001f${key}`;
    const existing = this.#entries.get(composite);
    const now = new Date().toISOString();
    const entry: StateEntry<T> = {
      key,
      value: structuredClone(value),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#entries.set(composite, entry);
    return structuredClone(entry);
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    return this.#entries.delete(`${namespace}\u001f${key}`);
  }

  async flush(): Promise<void> {
    // There is no backing file for this implementation.
  }
}

interface FileStateDocument {
  version: 1;
  namespaces: Record<string, Record<string, StateEntry>>;
}

export class FileStateStore implements StateStore {
  readonly #filePath: string;
  readonly #ready: Promise<void>;
  #document: FileStateDocument = { version: 1, namespaces: {} };
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
    this.#ready = this.#load();
  }

  async get<T>(namespace: string, key: string): Promise<StateEntry<T> | undefined> {
    await this.#ready;
    await this.#writeQueue;
    const entry = this.#document.namespaces[namespace]?.[key];
    return entry ? (structuredClone(entry) as StateEntry<T>) : undefined;
  }

  async list<T>(namespace: string): Promise<readonly StateEntry<T>[]> {
    await this.#ready;
    await this.#writeQueue;
    return Object.values(this.#document.namespaces[namespace] ?? {})
      .map((entry) => structuredClone(entry) as StateEntry<T>)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async set<T>(namespace: string, key: string, value: T): Promise<StateEntry<T>> {
    return await this.#enqueue(async () => {
      const records = (this.#document.namespaces[namespace] ??= {});
      const existing = records[key];
      const now = new Date().toISOString();
      const entry: StateEntry<T> = {
        key,
        value: structuredClone(value),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      records[key] = entry;
      await this.#persist();
      return structuredClone(entry);
    });
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    return await this.#enqueue(async () => {
      const records = this.#document.namespaces[namespace];
      if (!records || !(key in records)) return false;
      delete records[key];
      if (Object.keys(records).length === 0) delete this.#document.namespaces[namespace];
      await this.#persist();
      return true;
    });
  }

  async flush(): Promise<void> {
    await this.#ready;
    await this.#writeQueue;
  }

  async #load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, 'utf8')) as FileStateDocument;
      if (parsed.version !== 1 || !parsed.namespaces || typeof parsed.namespaces !== 'object') {
        throw new Error('Unsupported central data file format.');
      }
      this.#document = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    await this.#ready;
    const result = this.#writeQueue.then(operation);
    this.#writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.#document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, this.#filePath);
    await chmod(this.#filePath, 0o600).catch(() => undefined);
  }
}

/** Append-only namespaces and their bounded in-memory/file retention. */
const TRACE_LOG_ENTRY_LIMIT = 16 * 1024;
const APPEND_NAMESPACE_CAPS: Record<string, number> = {
  'trace-log': TRACE_LOG_ENTRY_LIMIT,
  'message-history': 5_000,
  'message-activity': 64 * 1024,
  'blueprint-activity': 5_000,
};

type StoredStateEntry<T = unknown> = StateEntry<T> & { readonly namespace: string };
type StoredTombstone = {
  readonly namespace: string;
  readonly key: string;
  readonly __deleted: true;
};

/**
 * A small log-structured store used by the central server's hot path.
 * Writes append one JSON line and reads use the in-memory authoritative copy.
 * A bounded/obsolete log is compacted synchronously only when it grows large.
 */
export class AppendLogStore implements StateStore {
  readonly #filePath: string;
  readonly #cap: number;
  readonly #namespace: string | undefined;
  readonly #memory = new Map<string, StoredStateEntry>();
  #permissionsEnsured = false;
  #lines = 0;

  constructor(filePath: string, cap = 0, namespace?: string) {
    this.#filePath = filePath;
    this.#cap = cap;
    this.#namespace = namespace;
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath)) {
      chmodSync(filePath, 0o600);
      this.#permissionsEnsured = true;
    }
    this.#load();
  }

  async get<T>(namespace: string, key: string): Promise<StateEntry<T> | undefined> {
    const entry = this.#memory.get(this.#composite(namespace, key));
    return entry ? (structuredClone(this.#publicEntry(entry)) as StateEntry<T>) : undefined;
  }

  async list<T>(namespace: string): Promise<readonly StateEntry<T>[]> {
    return [...this.#memory.values()]
      .filter((entry) => entry.namespace === namespace)
      .map((entry) => structuredClone(this.#publicEntry(entry)) as StateEntry<T>)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async set<T>(namespace: string, key: string, value: T): Promise<StateEntry<T>> {
    const composite = this.#composite(namespace, key);
    const previous = this.#memory.get(composite);
    const now = new Date().toISOString();
    const entry: StoredStateEntry<T> = {
      namespace,
      key,
      value: structuredClone(value),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (previous) this.#memory.delete(composite);
    this.#memory.set(composite, entry);
    this.#append(entry);
    this.#trim();
    this.#compact();
    return structuredClone(this.#publicEntry(entry));
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    const composite = this.#composite(namespace, key);
    if (!this.#memory.delete(composite)) return false;
    this.#append({ namespace, key, __deleted: true });
    return true;
  }

  async flush(): Promise<void> {
    // appendFileSync has already crossed the same process-level persistence
    // boundary as the previous implementation's writeFile/rename pair.
  }

  async close(): Promise<void> {
    this.#compact(true);
  }

  /** Load already parsed legacy entries during the one-time migration. */
  bulkLoad(namespace: string, entries: readonly StateEntry[]): void {
    for (const entry of entries) {
      this.#memory.set(this.#composite(namespace, entry.key), {
        namespace,
        key: entry.key,
        value: structuredClone(entry.value),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
    this.#trim();
    this.#compact(true);
  }

  #composite(namespace: string, key: string): string {
    return `${namespace}\u001f${key}`;
  }

  #publicEntry<T>(entry: StoredStateEntry<T>): StateEntry<T> {
    return {
      key: entry.key,
      value: entry.value,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  #append(entry: StoredStateEntry | StoredTombstone): void {
    appendFileSync(this.#filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    if (!this.#permissionsEnsured) {
      chmodSync(this.#filePath, 0o600);
      this.#permissionsEnsured = true;
    }
    this.#lines += 1;
  }

  #trim(): void {
    if (this.#cap <= 0) return;
    if (this.#namespace) {
      while (this.#memory.size > this.#cap) {
        const oldestKey = this.#memory.keys().next().value;
        if (typeof oldestKey !== 'string') break;
        this.#memory.delete(oldestKey);
      }
      return;
    }
    const entries = [...this.#memory.values()]
      .filter((entry) => !this.#namespace || entry.namespace === this.#namespace)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const entry of entries.slice(0, Math.max(0, entries.length - this.#cap))) {
      this.#memory.delete(this.#composite(entry.namespace, entry.key));
    }
  }

  #compact(force = false): void {
    const overCap = this.#cap > 0 && this.#lines > this.#cap * 2;
    const deadHeavy = this.#cap === 0 && this.#lines > Math.max(100, this.#memory.size * 2);
    if (!force && !overCap && !deadHeavy) return;
    const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
    const lines = [...this.#memory.values()]
      .filter((entry) => !this.#namespace || entry.namespace === this.#namespace)
      .map((entry) => JSON.stringify(entry));
    writeFileSync(temporaryPath, lines.length ? `${lines.join('\n')}\n` : '', {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.#filePath);
    chmodSync(this.#filePath, 0o600);
    this.#permissionsEnsured = true;
    this.#lines = lines.length;
  }

  #load(): void {
    if (!existsSync(this.#filePath)) return;
    const contents = readFileSync(this.#filePath, 'utf8');
    for (const line of contents.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      this.#lines += 1;
      try {
        const parsed = JSON.parse(line) as Partial<StoredStateEntry> & StoredTombstone;
        const namespace = parsed.namespace ?? this.#namespace;
        if (!namespace || typeof parsed.key !== 'string') continue;
        const composite = this.#composite(namespace, parsed.key);
        if (parsed.__deleted) this.#memory.delete(composite);
        else if (typeof parsed.createdAt === 'string' && typeof parsed.updatedAt === 'string') {
          this.#memory.delete(composite);
          this.#memory.set(composite, {
            namespace,
            key: parsed.key,
            value: structuredClone(parsed.value),
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt,
          });
        }
      } catch {
        // A process crash can leave a partial final line; later records remain readable.
      }
    }
    this.#trim();
  }
}

/** Routes append-heavy namespaces away from the small state file. */
export class SplitStateStore implements StateStore {
  readonly #state: AppendLogStore;
  readonly #append: Map<string, AppendLogStore>;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#state = new AppendLogStore(join(dataDir, 'state.ndjson'));
    this.#append = new Map(
      Object.entries(APPEND_NAMESPACE_CAPS).map(([namespace, cap]) => [
        namespace,
        new AppendLogStore(join(dataDir, `${namespace}.ndjson`), cap, namespace),
      ]),
    );
    this.#migrateLegacy(dataDir);
  }

  async get<T>(namespace: string, key: string): Promise<StateEntry<T> | undefined> {
    return await this.#storeFor(namespace).get(namespace, key);
  }

  async list<T>(namespace: string): Promise<readonly StateEntry<T>[]> {
    return await this.#storeFor(namespace).list(namespace);
  }

  async set<T>(namespace: string, key: string, value: T): Promise<StateEntry<T>> {
    return await this.#storeFor(namespace).set(namespace, key, value);
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    return await this.#storeFor(namespace).delete(namespace, key);
  }

  async flush(): Promise<void> {
    await this.#state.flush();
    await Promise.all([...this.#append.values()].map((store) => store.flush()));
  }

  async close(): Promise<void> {
    await this.#state.close();
    await Promise.all([...this.#append.values()].map((store) => store.close()));
  }

  #storeFor(namespace: string): AppendLogStore {
    return this.#append.get(namespace) ?? this.#state;
  }

  #migrateLegacy(dataDir: string): void {
    const legacyPath = join(dataDir, 'central.json');
    if (!existsSync(legacyPath)) return;
    const parsed = JSON.parse(readFileSync(legacyPath, 'utf8')) as FileStateDocument;
    if (parsed.version !== 1 || !parsed.namespaces || typeof parsed.namespaces !== 'object') {
      throw new Error('Unsupported central data file format.');
    }
    for (const [namespace, records] of Object.entries(parsed.namespaces)) {
      this.#storeFor(namespace).bulkLoad(
        namespace,
        Object.values(records).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)),
      );
    }
    renameSync(legacyPath, `${legacyPath}.migrated-${Date.now()}`);
    console.error('[DisQord/State] migrated legacy central.json to split ndjson files');
  }
}

export interface SecretStore {
  has(name: string): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  readonly #secrets = new Map<string, string>();

  async has(name: string): Promise<boolean> {
    return this.#secrets.has(name);
  }

  async get(name: string): Promise<string | undefined> {
    return this.#secrets.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    this.#secrets.set(name, value);
  }
}

export class PlaintextSecretStore implements SecretStore {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  async has(name: string): Promise<boolean> {
    return Boolean(await this.#store.get('plaintext-secret', name));
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.#store.get<string>('plaintext-secret', name))?.value;
  }

  async set(name: string, value: string): Promise<void> {
    await this.#store.set('plaintext-secret', name, value);
  }
}
