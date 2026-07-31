import { randomUUID } from 'node:crypto';

import {
  type Blueprint,
  type BlueprintNode,
  type BlueprintVersion,
  type ChatSession,
  type MessageEnvelope,
} from '@disqord/shared';
import { describe, expect, it, vi } from 'vitest';

import { MessageOrchestrator, type MessageProcessor } from './orchestrator.js';
import { InMemoryStateStore } from './state-store.js';

function message(nodeId: string, text = '你好'): MessageEnvelope {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    source: {
      nodeId,
      platform: 'qq',
      spaceId: 'qq-group',
      channelId: 'qq-group',
      messageId: randomUUID(),
    },
    sender: { id: 'sender', displayName: 'Sender' },
    sentAt: new Date().toISOString(),
    kind: 'text',
    text,
    attachments: [],
    traceId: randomUUID(),
  };
}

async function fixture(
  nodes: BlueprintNode[],
  edges: BlueprintVersion['edges'],
  processor: MessageProcessor,
) {
  const store = new InMemoryStateStore();
  const now = new Date().toISOString();
  const qqNodeId = randomUUID();
  const discordNodeId = randomUUID();
  const sourceSession: ChatSession = {
    id: randomUUID(),
    nodeId: qqNodeId,
    platform: 'qq',
    externalId: 'qq-group',
    spaceId: 'qq-group',
    displayName: 'QQ group',
    status: 'verified',
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const targetSession: ChatSession = {
    id: randomUUID(),
    nodeId: discordNodeId,
    platform: 'discord',
    externalId: 'discord-channel',
    spaceId: 'discord-server',
    displayName: 'Discord channel',
    status: 'verified',
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  for (const session of [sourceSession, targetSession]) {
    await store.set('chat-session', session.id, session);
  }
  const blueprintId = randomUUID();
  const resolvedNodes = nodes.map((node) => ({
    ...node,
    config: {
      ...node.config,
      ...(node.config.sessionRole === 'source' ? { sessionId: sourceSession.id } : {}),
      ...(node.config.sessionRole === 'target' ? { sessionId: targetSession.id } : {}),
    },
  }));
  const blueprint: Blueprint = {
    id: blueprintId,
    name: 'Pipeline',
    enabled: true,
    activeVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  const version: BlueprintVersion = {
    id: randomUUID(),
    blueprintId,
    version: 1,
    status: 'published',
    nodes: resolvedNodes,
    edges,
    createdBy: randomUUID(),
    createdAt: now,
    publishedAt: now,
  };
  await store.set('blueprint', blueprintId, blueprint);
  await store.set('blueprint-version', `${blueprintId}:1`, version);
  const sendToNode = vi.fn(async () => undefined);
  const orchestrator = new MessageOrchestrator(store, { sendToNode }, processor);
  return { store, orchestrator, sendToNode, sourceSession, targetSession, blueprint };
}

function node(
  id: string,
  type: BlueprintNode['type'],
  config: Record<string, unknown> = {},
): BlueprintNode {
  return { id, type, position: { x: 0, y: 0 }, config };
}

describe('blueprint message pipeline', () => {
  it('silently ignores messages from sessions that were not verified', async () => {
    const process = vi.fn(async () => ({
      decision: 'allow' as const,
      cards: [Buffer.from('card')],
    }));
    const setup = await fixture([], [], { process });
    const incoming = message(setup.sourceSession.nodeId);
    incoming.source.channelId = 'unconfigured-group';
    incoming.source.spaceId = 'unconfigured-group';

    await setup.orchestrator.handleNodeFrame({
      nodeId: setup.sourceSession.nodeId,
      nodeType: 'qq',
      kind: 'message.upload',
      payload: incoming,
      frameId: randomUUID(),
    });

    expect(process).not.toHaveBeenCalled();
    expect(await setup.store.list('trace-log')).toHaveLength(0);
    expect(await setup.store.list('message-dedupe')).toHaveLength(0);
  });

  it('does not execute a disabled blueprint and keeps legacy direct routes compatible', async () => {
    const input = randomUUID();
    const output = randomUUID();
    const process = vi.fn(async () => ({
      decision: 'allow' as const,
      cards: [Buffer.from('legacy-card')],
    }));
    const setup = await fixture(
      [
        node(input, 'chat-input', { sessionRole: 'source' }),
        node(output, 'chat-output', { sessionRole: 'target' }),
      ],
      [{ id: randomUUID(), sourceNodeId: input, targetNodeId: output }],
      { process },
    );
    await setup.store.set('blueprint', setup.blueprint.id, {
      ...setup.blueprint,
      enabled: false,
    });
    const incoming = message(setup.sourceSession.nodeId);
    await setup.orchestrator.handleNodeFrame({
      nodeId: setup.sourceSession.nodeId,
      nodeType: 'qq',
      kind: 'message.upload',
      payload: incoming,
      frameId: randomUUID(),
    });
    expect(process).not.toHaveBeenCalled();

    await setup.store.set('blueprint', setup.blueprint.id, setup.blueprint);
    await setup.orchestrator.handleNodeFrame({
      nodeId: setup.sourceSession.nodeId,
      nodeType: 'qq',
      kind: 'message.upload',
      payload: message(setup.sourceSession.nodeId),
      frameId: randomUUID(),
    });
    expect(setup.sendToNode).toHaveBeenCalledWith(
      setup.targetSession.nodeId,
      'message.deliver',
      expect.objectContaining({ cards: [Buffer.from('legacy-card').toString('base64')] }),
    );
  });

  it('translates with memory, evaluates the score, and follows the passed output', async () => {
    const input = randomUUID();
    const translation = randomUUID();
    const moderation = randomUUID();
    const renderer = randomUUID();
    const output = randomUUID();
    const blocked = randomUUID();
    const translate = vi.fn(async () => ({
      detectedLanguage: 'zh',
      translatedText: 'Hello',
      confidence: 0.99,
      model: 'translator',
      promptVersion: 1,
    }));
    const moderate = vi.fn(async () => ({
      violationScore: 0.2,
      categories: [],
      reason: '正常内容',
      confidence: 0.98,
      model: 'moderator',
    }));
    const render = vi.fn(async (_message, _target, text) => [Buffer.from(text)]);
    const setup = await fixture(
      [
        node(input, 'chat-input', { sessionRole: 'source' }),
        node(translation, 'llm-translation', { prompt: '翻译提示词', memoryMode: true }),
        node(moderation, 'llm-moderation', { prompt: '审核提示词', threshold: 0.5 }),
        node(renderer, 'card-renderer'),
        node(output, 'chat-output', { sessionRole: 'target' }),
        node(blocked, 'discard'),
      ],
      [
        { id: randomUUID(), sourceNodeId: input, targetNodeId: translation },
        { id: randomUUID(), sourceNodeId: translation, targetNodeId: moderation },
        {
          id: randomUUID(),
          sourceNodeId: moderation,
          sourceHandle: 'passed',
          targetNodeId: renderer,
        },
        {
          id: randomUUID(),
          sourceNodeId: moderation,
          sourceHandle: 'blocked',
          targetNodeId: blocked,
        },
        { id: randomUUID(), sourceNodeId: renderer, targetNodeId: output },
      ],
      { translate, moderate, render },
    );
    await setup.store.set('message-history', randomUUID(), {
      sessionId: setup.sourceSession.id,
      message: message(setup.sourceSession.nodeId, '上一条'),
    });
    const incoming = message(setup.sourceSession.nodeId);
    await setup.orchestrator.handleNodeFrame({
      nodeId: setup.sourceSession.nodeId,
      nodeType: 'qq',
      kind: 'message.upload',
      payload: incoming,
      frameId: randomUUID(),
    });

    expect(translate).toHaveBeenCalledWith(
      incoming,
      setup.targetSession,
      '你好',
      '翻译提示词',
      expect.arrayContaining([expect.objectContaining({ text: '上一条' })]),
      true,
    );
    expect(moderate).toHaveBeenCalledWith('Hello', '审核提示词');
    expect(render).toHaveBeenCalledWith(incoming, setup.targetSession, 'Hello', false);
    expect(setup.sendToNode).toHaveBeenCalledOnce();
    const sentCommand = setup.sendToNode.mock.calls[0]![2] as {
      taskId: string;
      sourceSessionId: string;
      sourceMessageId: string;
      targetSessionId: string;
    };
    await setup.orchestrator.handleNodeFrame({
      nodeId: setup.targetSession.nodeId,
      nodeType: 'discord',
      kind: 'message.delivered',
      payload: { ...sentCommand, targetMessageId: 'discord-message-id' },
      frameId: randomUUID(),
    });
    const logs = (await setup.store.list<Record<string, unknown>>('trace-log')).map(
      (entry) => entry.value,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'info', event: 'translation_response' }),
        expect.objectContaining({ level: 'info', event: 'moderation_response' }),
        expect.objectContaining({ level: 'info', event: 'delivery_queued' }),
        expect.objectContaining({ level: 'info', event: 'delivery_succeeded' }),
      ]),
    );
  });

  it('routes a high score through fixed text and renders the replacement', async () => {
    const input = randomUUID();
    const moderation = randomUUID();
    const fixed = randomUUID();
    const renderer = randomUUID();
    const output = randomUUID();
    const passed = randomUUID();
    const render = vi.fn(async (_message, _target, text) => [Buffer.from(text)]);
    const setup = await fixture(
      [
        node(input, 'chat-input', { sessionRole: 'source' }),
        node(moderation, 'llm-moderation', { prompt: '评分', threshold: 0.4 }),
        node(fixed, 'fixed-text', { text: '内容未通过审核' }),
        node(renderer, 'card-renderer'),
        node(output, 'chat-output', { sessionRole: 'target' }),
        node(passed, 'discard'),
      ],
      [
        { id: randomUUID(), sourceNodeId: input, targetNodeId: moderation },
        {
          id: randomUUID(),
          sourceNodeId: moderation,
          sourceHandle: 'passed',
          targetNodeId: passed,
        },
        {
          id: randomUUID(),
          sourceNodeId: moderation,
          sourceHandle: 'blocked',
          targetNodeId: fixed,
        },
        { id: randomUUID(), sourceNodeId: fixed, targetNodeId: renderer },
        { id: randomUUID(), sourceNodeId: renderer, targetNodeId: output },
      ],
      {
        moderate: vi.fn(async () => ({
          violationScore: 0.9,
          categories: ['abuse'],
          reason: '违规',
          confidence: 1,
          model: 'moderator',
        })),
        render,
      },
    );
    const incoming = message(setup.sourceSession.nodeId);
    await setup.orchestrator.handleNodeFrame({
      nodeId: setup.sourceSession.nodeId,
      nodeType: 'qq',
      kind: 'message.upload',
      payload: incoming,
      frameId: randomUUID(),
    });
    expect(render).toHaveBeenCalledWith(incoming, setup.targetSession, '内容未通过审核', true);
    expect(setup.sendToNode).toHaveBeenCalledOnce();
    const sentCommand = setup.sendToNode.mock.calls[0]![2] as {
      taskId: string;
      sourceSessionId: string;
      sourceMessageId: string;
      targetSessionId: string;
    };
    await setup.orchestrator.handleNodeFrame({
      nodeId: setup.targetSession.nodeId,
      nodeType: 'discord',
      kind: 'message.delivery_failed',
      payload: { ...sentCommand, error: 'Discord API unavailable' },
      frameId: randomUUID(),
    });
    const logs = (await setup.store.list<Record<string, unknown>>('trace-log')).map(
      (entry) => entry.value,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', event: 'delivery_failed' }),
      ]),
    );
  });
});
