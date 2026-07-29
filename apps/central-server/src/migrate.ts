import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { Pool, type PoolClient } from 'pg';

const migrationFilePattern = /^\d{4}_[a-z0-9_]+\.sql$/u;

export interface MigrationResult {
  readonly applied: readonly string[];
}

export async function migrateDatabase(connectionString: string): Promise<MigrationResult> {
  const pool = new Pool({ connectionString, max: 1 });

  try {
    const client = await pool.connect();
    try {
      return await applyMigrations(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function applyMigrations(client: PoolClient): Promise<MigrationResult> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationDirectory = new URL('../migrations/', import.meta.url);
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => migrationFilePattern.test(name))
    .sort();
  const applied: string[] = [];

  for (const migrationName of migrationNames) {
    const existing = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations WHERE name = $1',
      [migrationName],
    );

    if (existing.rowCount) {
      continue;
    }

    const sql = await readFile(new URL(migrationName, migrationDirectory), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migrationName]);
      await client.query('COMMIT');
      applied.push(migrationName);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  return { applied };
}

async function runFromCommandLine(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required.');
  }

  const result = await migrateDatabase(connectionString);
  console.info(
    result.applied.length > 0
      ? `Applied migrations: ${result.applied.join(', ')}`
      : 'Database schema is already up to date.',
  );
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(entryPath).href === import.meta.url) {
  runFromCommandLine().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Database migration failed.');
    process.exitCode = 1;
  });
}
