import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
