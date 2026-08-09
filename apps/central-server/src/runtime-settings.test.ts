import { randomUUID } from 'node:crypto';

import { type Blueprint, type BlueprintVersion, type ChatSession } from '@disqord/shared';
import { describe, expect, it } from 'vitest';

import { resolveUploadSessions } from './runtime-settings.js';
import { InMemoryStateStore } from './state-store.js';

describe('resolveUploadSessions', () => {
  it('returns only verified chat inputs in enabled active blueprints for the requested node', async () => {
    const store = new InMemoryStateStore();
    const now = new Date().toISOString();
    const qqNodeId = randomUUID();
    const discordNodeId = randomUUID();
    const source: ChatSession = {
      id: randomUUID(),
      nodeId: qqNodeId,
      platform: 'qq',
      externalId: '100',
      spaceId: '100',
      displayName: 'source',
      status: 'verified',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const target: ChatSession = {
      id: randomUUID(),
      nodeId: discordNodeId,
      platform: 'discord',
      externalId: '200',
      spaceId: 'guild',
      displayName: 'target',
      status: 'verified',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const disabledSource: ChatSession = {
      ...source,
      id: randomUUID(),
      externalId: '300',
      spaceId: '300',
      displayName: 'disabled source',
    };
    for (const session of [source, target, disabledSource]) {
      await store.set('chat-session', session.id, session);
    }

    const activeId = randomUUID();
    const disabledId = randomUUID();
    const active: Blueprint = {
      id: activeId,
      name: 'active',
      enabled: true,
      activeVersion: 2,
      createdAt: now,
      updatedAt: now,
    };
    const disabled: Blueprint = {
      id: disabledId,
      name: 'disabled',
      enabled: false,
      activeVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    await store.set('blueprint', active.id, active);
    await store.set('blueprint', disabled.id, disabled);
    const version = (
      blueprintId: string,
      number: number,
      sessionId: string,
      status: BlueprintVersion['status'] = 'published',
    ): BlueprintVersion => ({
      id: randomUUID(),
      blueprintId,
      version: number,
      status,
      createdBy: randomUUID(),
      createdAt: now,
      nodes: [
        { id: randomUUID(), type: 'chat-input', position: { x: 0, y: 0 }, config: { sessionId } },
        {
          id: randomUUID(),
          type: 'chat-output',
          position: { x: 1, y: 0 },
          config: { sessionId: target.id },
        },
      ],
      edges: [],
      ...(status === 'published' ? { publishedAt: now } : {}),
    });
    for (const item of [
      version(activeId, 1, disabledSource.id, 'archived'),
      version(activeId, 2, source.id),
      version(disabledId, 1, disabledSource.id),
    ]) {
      await store.set('blueprint-version', `${item.blueprintId}:${item.version}`, item);
    }

    await expect(resolveUploadSessions(store, qqNodeId)).resolves.toEqual([
      { spaceId: '100', channelId: '100' },
    ]);
    await expect(resolveUploadSessions(store, discordNodeId)).resolves.toEqual([]);
  });
});
