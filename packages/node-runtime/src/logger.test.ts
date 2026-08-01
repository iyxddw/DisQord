import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeLogger } from './logger.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('NodeLogger', () => {
  it('writes structured levels and filters paginated records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'disqord-node-log-'));
    directories.push(directory);
    const logger = new NodeLogger(join(directory, 'node.jsonl'));
    logger.write('info', 'message_received', { channelId: 'qq-1' });
    logger.write('debug', 'queue_inspected', { channelId: 'qq-1' });
    logger.write('error', 'delivery_failed', { channelId: 'discord-1' });

    expect(logger.list({ level: 'info' })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ event: 'message_received', level: 'info' })],
    });
    expect(logger.list({ search: 'discord', pageSize: 10 })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ event: 'delivery_failed' })],
    });
  });
});
