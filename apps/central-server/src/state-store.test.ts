import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { FileStateStore, PlaintextSecretStore, SplitStateStore } from './state-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), 'disqord-state-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'central.json');
  return { filePath, store: new FileStateStore(filePath) };
}

describe('file state store', () => {
  it('persists namespaces and entries across instances', async () => {
    const { filePath, store } = await createStore();
    const created = await store.set('settings', 'example', { enabled: true });
    expect(created.value).toEqual({ enabled: true });

    const restored = new FileStateStore(filePath);
    expect((await restored.get('settings', 'example'))?.value).toEqual({ enabled: true });
  });

  it('stores secrets as plaintext in the same data file', async () => {
    const { filePath, store } = await createStore();
    const secrets = new PlaintextSecretStore(store);
    await secrets.set('llm-api-key', 'plain-personal-project-key');

    expect(await secrets.get('llm-api-key')).toBe('plain-personal-project-key');
    expect(await readFile(filePath, 'utf8')).toContain('plain-personal-project-key');
  });

  it('serializes concurrent writes without losing entries', async () => {
    const { filePath, store } = await createStore();
    await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        await store.set('items', String(index), { index });
      }),
    );

    expect(await store.list('items')).toHaveLength(20);
    const restored = new FileStateStore(filePath);
    expect(await restored.list('items')).toHaveLength(20);
  });
});

describe('split append state store', () => {
  it('keeps namespaces separate and restores them from ndjson files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disqord-split-state-'));
    temporaryDirectories.push(directory);
    const store = new SplitStateStore(directory);
    await store.set('settings', 'same-key', { kind: 'settings' });
    await store.set('prompt', 'same-key', { kind: 'prompt' });
    await store.set('trace-log', 'trace-1', { event: 'received' });
    await store.flush();
    await store.close();

    const restored = new SplitStateStore(directory);
    expect((await restored.get('settings', 'same-key'))?.value).toEqual({ kind: 'settings' });
    expect((await restored.get('prompt', 'same-key'))?.value).toEqual({ kind: 'prompt' });
    expect(await restored.list('trace-log')).toHaveLength(1);
    expect(await readdir(directory)).toEqual(
      expect.arrayContaining(['state.ndjson', 'trace-log.ndjson']),
    );
    await restored.close();
  });

  it('migrates the legacy central document and leaves a rollback copy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disqord-split-migrate-'));
    temporaryDirectories.push(directory);
    const createdAt = '2026-01-01T00:00:00.000Z';
    await writeFile(
      join(directory, 'central.json'),
      JSON.stringify({
        version: 1,
        namespaces: {
          settings: {
            llm: { key: 'llm', value: { fastMode: true }, createdAt, updatedAt: createdAt },
          },
          'trace-log': {
            trace: {
              key: 'trace',
              value: { event: 'message_received' },
              createdAt,
              updatedAt: createdAt,
            },
          },
        },
      }),
      'utf8',
    );

    const store = new SplitStateStore(directory);
    expect((await store.get('settings', 'llm'))?.value).toEqual({ fastMode: true });
    expect(await store.list('trace-log')).toHaveLength(1);
    expect(
      (await readdir(directory)).some((name) => name.startsWith('central.json.migrated-')),
    ).toBe(true);
    expect((await readdir(directory)).includes('central.json')).toBe(false);
    await store.close();
  });
});
