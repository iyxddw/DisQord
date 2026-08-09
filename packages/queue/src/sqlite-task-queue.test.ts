import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileTaskQueue } from './sqlite-task-queue.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createQueuePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'disqord-queue-'));
  temporaryDirectories.push(directory);
  return join(directory, 'queue.json');
}

describe('FileTaskQueue', () => {
  it('restores unfinished work after reopening the JSON file', () => {
    const databasePath = createQueuePath();
    const itemId = randomUUID();
    const firstProcess = new FileTaskQueue(databasePath);

    expect(
      firstProcess.enqueue({
        id: itemId,
        kind: 'message-upload',
        payload: { messageId: 'qq-100' },
      }),
    ).toBe(true);
    firstProcess.markProcessing(itemId);
    firstProcess.close();

    const restartedProcess = new FileTaskQueue(databasePath);
    expect(restartedProcess.listRecoverable()).toMatchObject([
      {
        id: itemId,
        status: 'processing',
        attempts: 1,
        payload: { messageId: 'qq-100' },
      },
    ]);
    restartedProcess.close();
  });

  it('deduplicates queue items by ID', () => {
    const queue = new FileTaskQueue(createQueuePath());
    const item = {
      id: randomUUID(),
      kind: 'message-upload',
      payload: { messageId: 'discord-100' },
    };

    expect(queue.enqueue(item)).toBe(true);
    expect(queue.enqueue(item)).toBe(false);
    expect(queue.listRecoverable()).toHaveLength(1);
    queue.close();
  });

  it('enforces queue state transitions', () => {
    const queue = new FileTaskQueue(createQueuePath());
    const itemId = randomUUID();
    queue.enqueue({ id: itemId, kind: 'delivery', payload: {} });

    expect(() => queue.markAcknowledged(itemId)).toThrow('cannot transition');
    queue.markProcessing(itemId);
    queue.markAcknowledged(itemId);
    expect(queue.get(itemId)?.status).toBe('acknowledged');
    queue.close();
  });

  it('persists payload updates for acknowledgement metadata', () => {
    const path = createQueuePath();
    const queue = new FileTaskQueue(path);
    const itemId = randomUUID();
    queue.enqueue({ id: itemId, kind: 'delivery', payload: { attempt: 1 } });
    queue.updatePayload(itemId, { attempt: 1, targetMessageId: 'platform-1' });
    expect(new FileTaskQueue(path).get(itemId)?.payload).toEqual({
      attempt: 1,
      targetMessageId: 'platform-1',
    });
    queue.close();
  });

  it('removes discarded work from the recoverable queue', () => {
    const queue = new FileTaskQueue(createQueuePath());
    const itemId = randomUUID();
    queue.enqueue({ id: itemId, kind: 'message-upload', payload: {} });

    queue.markDiscarded(itemId);

    expect(queue.get(itemId)?.status).toBe('discarded');
    expect(queue.listRecoverable()).toEqual([]);
    queue.close();
  });
});
