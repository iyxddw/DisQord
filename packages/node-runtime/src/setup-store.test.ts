import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeSetupStore } from './setup-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true })));
});

describe('NodeSetupStore', () => {
  it('returns undefined before setup and atomically persists configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disqord-node-setup-'));
    directories.push(directory);
    const path = join(directory, 'nested', 'setup.json');
    const store = new NodeSetupStore<{ centralUrl: string }>(path);

    await expect(store.load()).resolves.toBeUndefined();
    await store.save({ centralUrl: 'wss://central.example.test/node' });

    await expect(store.load()).resolves.toEqual({
      centralUrl: 'wss://central.example.test/node',
    });
    expect(await readFile(path, 'utf8')).toContain('central.example.test');
  });
});
