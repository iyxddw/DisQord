import { randomUUID } from 'node:crypto';

import { PromptVersionStore } from '@disqord/llm';
import {
  type Blueprint,
  type BlueprintVersion,
  type ChatSession,
  type MessageEnvelope,
} from '@disqord/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  CentralMessageProcessor,
  MessageOrchestrator,
  type MessageProcessor,
  type NodeCommandBus,
} from './orchestrator.js';
import { InMemorySecretStore, InMemoryStateStore } from './state-store.js';

describe('message orchestrator blueprint activation', () => {
  it('does not process messages through a disabled published blueprint', async () => {
    const store = new InMemoryStateStore();
    const now = new Date().toISOString();
    const qqNodeId = randomUUID();
    const discordNodeId = randomUUID();
    const sourceSessionId = randomUUID();
    const targetSessionId = randomUUID();
    const blueprintId = randomUUID();
    const inputNodeId = randomUUID();
    const outputNodeId = randomUUID();
    const sessions: ChatSession[] = [
      {
        id: sourceSessionId,
        nodeId: qqNodeId,
        platform: 'qq',
        externalId: 'qq-group',
        spaceId: 'qq-group',
        displayName: 'QQ group',
        status: 'verified',
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: targetSessionId,
        nodeId: discordNodeId,
        platform: 'discord',
        externalId: 'discord-channel',
        spaceId: 'discord-server',
        displayName: 'Discord channel',
        status: 'verified',
        verifiedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ];
    for (const session of sessions) await store.set('chat-session', session.id, session);
    const blueprint: Blueprint = {
      id: blueprintId,
      name: 'Disabled route',
      enabled: false,
      activeVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    const version: BlueprintVersion = {
      id: randomUUID(),
      blueprintId,
      version: 1,
      status: 'published',
      nodes: [
        {
          id: inputNodeId,
          type: 'chat-input',
          position: { x: 0, y: 0 },
          config: { sessionId: sourceSessionId },
        },
        {
          id: outputNodeId,
          type: 'chat-output',
          position: { x: 300, y: 0 },
          config: { sessionId: targetSessionId },
        },
      ],
      edges: [
        {
          id: randomUUID(),
          sourceNodeId: inputNodeId,
          targetNodeId: outputNodeId,
        },
      ],
      createdBy: randomUUID(),
      createdAt: now,
      publishedAt: now,
    };
    await store.set('blueprint', blueprintId, blueprint);
    await store.set('blueprint-version', `${blueprintId}:1`, version);

    const process = vi.fn<MessageProcessor['process']>(async () => ({
      decision: 'allow',
      cards: [],
    }));
    const commandBus: NodeCommandBus = { sendToNode: vi.fn(async () => undefined) };
    const orchestrator = new MessageOrchestrator(store, commandBus, { process });
    const message: MessageEnvelope = {
      schemaVersion: 1,
      eventId: randomUUID(),
      source: {
        nodeId: qqNodeId,
        platform: 'qq',
        spaceId: 'qq-group',
        channelId: 'qq-group',
        messageId: 'message-1',
      },
      sender: { id: 'sender', displayName: 'Sender' },
      sentAt: now,
      kind: 'text',
      text: 'hello',
      attachments: [],
      traceId: randomUUID(),
    };

    await orchestrator.handleNodeFrame({
      nodeId: qqNodeId,
      nodeType: 'qq',
      kind: 'message.upload',
      payload: message,
      frameId: randomUUID(),
    });

    expect(process).not.toHaveBeenCalled();
    expect(commandBus.sendToNode).not.toHaveBeenCalled();
  });
});

describe('unreviewable image moderation policy', () => {
  async function createProcessor(policy: 'allow' | 'block') {
    const store = new InMemoryStateStore();
    const secrets = new InMemorySecretStore();
    await store.set('settings', 'llm', {
      baseUrl: 'https://llm.example.test/v1',
      translationModel: 'translation-model',
      moderationModel: 'moderation-model',
      timeoutMs: 30_000,
      maxRetries: 0,
      concurrency: 1,
      unreviewableImagePolicy: policy,
    });
    await secrets.set('llm-api-key', 'test-key');
    const prompts = new PromptVersionStore();
    prompts.createDefaultVersions(randomUUID());
    for (const purpose of [
      'translation-system',
      'translation-task',
      'moderation-system',
      'moderation-rules',
    ] as const) {
      const prompt = prompts.getPublished(purpose);
      await store.set('prompt', prompt.id, prompt);
    }
    return new CentralMessageProcessor(store, secrets);
  }

  function createImageMessage(): MessageEnvelope {
    return {
      schemaVersion: 1,
      eventId: randomUUID(),
      source: {
        nodeId: randomUUID(),
        platform: 'qq',
        spaceId: 'qq-group',
        channelId: 'qq-group',
        messageId: 'image-message',
      },
      sender: { id: 'sender', displayName: 'Sender' },
      sentAt: new Date().toISOString(),
      kind: 'image',
      attachments: [
        {
          id: randomUUID(),
          fileName: 'image.jpg',
          mimeType: 'image/jpeg',
          byteSize: 0,
          sha256: '0'.repeat(64),
        },
      ],
      traceId: randomUUID(),
    };
  }

  const target: ChatSession = {
    id: randomUUID(),
    nodeId: randomUUID(),
    platform: 'discord',
    externalId: 'discord-channel',
    spaceId: 'discord-server',
    displayName: 'Discord channel',
    status: 'verified',
    verifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('blocks an image when no vision model is configured and policy is block', async () => {
    const result = await (await createProcessor('block')).process(createImageMessage(), target);
    expect(result).toMatchObject({ decision: 'block' });
    expect(result.reason).toContain('no vision model');
    expect(result.moderation).toMatchObject({ categories: ['unreviewable-image'] });
  });

  it('allows and renders an image when no vision model is configured and policy is allow', async () => {
    const result = await (await createProcessor('allow')).process(createImageMessage(), target);
    expect(result.decision).toBe('allow');
    expect(result.cards).toHaveLength(1);
    expect(result.moderation).toMatchObject({
      decision: 'allow',
      categories: ['unreviewable-image'],
    });
  });
});
