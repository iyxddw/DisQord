import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { type Pool } from 'pg';

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

interface PostgresStateRow {
  key: string;
  value: unknown;
  created_at: Date;
  updated_at: Date;
}

export class PostgresStateStore implements StateStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async get<T>(namespace: string, key: string): Promise<StateEntry<T> | undefined> {
    const result = await this.#pool.query<PostgresStateRow>(
      `
        SELECT key, value, created_at, updated_at
        FROM central_kv
        WHERE namespace = $1 AND key = $2
      `,
      [namespace, key],
    );
    return result.rows[0] ? mapStateRow<T>(result.rows[0]) : undefined;
  }

  async list<T>(namespace: string): Promise<readonly StateEntry<T>[]> {
    const result = await this.#pool.query<PostgresStateRow>(
      `
        SELECT key, value, created_at, updated_at
        FROM central_kv
        WHERE namespace = $1
        ORDER BY updated_at DESC
      `,
      [namespace],
    );
    return result.rows.map((row) => mapStateRow<T>(row));
  }

  async set<T>(namespace: string, key: string, value: T): Promise<StateEntry<T>> {
    const result = await this.#pool.query<PostgresStateRow>(
      `
        INSERT INTO central_kv (namespace, key, value, created_at, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW(), NOW())
        ON CONFLICT (namespace, key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        RETURNING key, value, created_at, updated_at
      `,
      [namespace, key, JSON.stringify(value)],
    );
    return mapStateRow<T>(result.rows[0]!);
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    const result = await this.#pool.query(
      'DELETE FROM central_kv WHERE namespace = $1 AND key = $2',
      [namespace, key],
    );
    return (result.rowCount ?? 0) > 0;
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

export class EncryptedPostgresSecretStore implements SecretStore {
  readonly #key: Buffer;
  readonly #pool: Pool;

  constructor(pool: Pool, encryptionKey: string) {
    if (encryptionKey.length < 32) throw new Error('Encryption key must contain 32 characters.');
    this.#pool = pool;
    this.#key = createHash('sha256').update(encryptionKey).digest();
  }

  async has(name: string): Promise<boolean> {
    const result = await this.#pool.query('SELECT 1 FROM central_secrets WHERE name = $1', [name]);
    return Boolean(result.rowCount);
  }

  async get(name: string): Promise<string | undefined> {
    const result = await this.#pool.query<{
      ciphertext: string;
      initialization_vector: string;
      authentication_tag: string;
    }>(
      `
        SELECT ciphertext, initialization_vector, authentication_tag
        FROM central_secrets WHERE name = $1
      `,
      [name],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#key,
      Buffer.from(row.initialization_vector, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(row.authentication_tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  async set(name: string, value: string): Promise<void> {
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, initializationVector);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();
    await this.#pool.query(
      `
        INSERT INTO central_secrets (
          name, ciphertext, initialization_vector, authentication_tag, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (name) DO UPDATE SET
          ciphertext = EXCLUDED.ciphertext,
          initialization_vector = EXCLUDED.initialization_vector,
          authentication_tag = EXCLUDED.authentication_tag,
          updated_at = NOW()
      `,
      [
        name,
        ciphertext.toString('base64'),
        initializationVector.toString('base64'),
        authenticationTag.toString('base64'),
      ],
    );
  }
}

function mapStateRow<T>(row: PostgresStateRow): StateEntry<T> {
  return {
    key: row.key,
    value: row.value as T,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
