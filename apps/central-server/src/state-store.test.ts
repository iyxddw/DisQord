import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { FileStateStore, PlaintextSecretStore } from './state-store.js';

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
