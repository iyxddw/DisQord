import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeConfigStore } from './config.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe('NodeConfigStore', () => {
  it('creates and reuses a stable node identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disqord-node-config-'));
    directories.push(directory);
    const path = join(directory, 'nested', 'node.json');
    const store = new NodeConfigStore(path);
    const first = await store.loadOrCreate('qq');
    const second = await store.loadOrCreate('qq');

    expect(second.identity.nodeId).toBe(first.identity.nodeId);
    expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty(
      'identity.privateKeyPem',
      '',
    );
  });

  it('rejects a config created for the other platform', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disqord-node-config-'));
    directories.push(directory);
    const store = new NodeConfigStore(join(directory, 'node.json'));
    await store.loadOrCreate('qq');

    await expect(store.loadOrCreate('discord')).rejects.toThrow('Node config belongs to qq');
  });

  it('persists the central upload-session whitelist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disqord-node-config-'));
    directories.push(directory);
    const store = new NodeConfigStore(join(directory, 'node.json'));
    const config = await store.loadOrCreate('qq');
    await store.save({
      ...config,
      uploadSessions: [{ spaceId: 'group-1', channelId: 'group-1' }],
    });

    await expect(store.loadOrCreate('qq')).resolves.toMatchObject({
      uploadSessions: [{ spaceId: 'group-1', channelId: 'group-1' }],
    });
  });
});
