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
  return { store, orchestrator, sendToNode, sourceSession, targetSession, blueprint, version };
}

function node(
  id: string,
  type: BlueprintNode['type'],
  config: Record<string, unknown> = {},
): BlueprintNode {
  return { id, type, position: { x: 0, y: 0 }, config };
}

describe('blueprint message pipeline', () => {
  it('runs a simulated input through the real pipeline and sends to a real target', async () => {
    const input = randomUUID();
    const translation = randomUUID();
    const moderation = randomUUID();
    const fixed = randomUUID();
    const output = randomUUID();
    const setup = await fixture(
      [
        node(input, 'simulated-input'),
        node(translation, 'llm-translation', { prompt: '翻译', memoryMode: false }),
        node(moderation, 'llm-moderation', { prompt: '审核', threshold: 0.5 }),
        node(fixed, 'fixed-text', { text: '内容未通过审核' }),
        node(output, 'chat-output', { sessionRole: 'target' }),
      ],
      [
        { id: randomUUID(), sourceNodeId: input, targetNodeId: translation },
        { id: randomUUID(), sourceNodeId: translation, targetNodeId: moderation },
        {
          id: randomUUID(),
          sourceNodeId: moderation,
          sourceHandle: 'passed',
          targetNodeId: output,
        },
        {
          id: randomUUID(),
          sourceNodeId: moderation,
          sourceHandle: 'blocked',
          targetNodeId: fixed,
        },
        { id: randomUUID(), sourceNodeId: fixed, targetNodeId: output },
      ],
      {
        translate: vi.fn(async () => ({
          detectedLanguage: 'zh',
          translatedText: 'Hello',
          confidence: 1,
          model: 'translator',
          promptVersion: 1,
        })),
        moderate: vi.fn(async () => ({
          violationScore: 0.34,
          categories: [],
          reason: '正常',
          confidence: 1,
          model: 'moderator',
        })),
        render: vi.fn(async () => [Buffer.from('rendered-card')]),
      },
    );

    const result = await setup.orchestrator.handleSimulatedInput(setup.blueprint.id, input, '你好');

    expect(result.traceId).toEqual(expect.any(String));
    expect(setup.sendToNode).toHaveBeenCalledWith(
      setup.targetSession.nodeId,
      'message.deliver',
      expect.objectContaining({
        targetSessionId: setup.targetSession.id,
        cards: [Buffer.from('rendered-card').toString('base64')],
      }),
    );
    const activities = (await setup.store.list<Record<string, unknown>>('blueprint-activity')).map(
      (entry) => entry.value,
    );
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: input, text: '你好' }),
        expect.objectContaining({ nodeId: translation, text: 'Hello' }),
        expect.objectContaining({ nodeId: moderation, violationScore: 0.34, route: 'passed' }),
        expect.objectContaining({ nodeId: output, text: 'Hello' }),
      ]),
    );
    expect(await setup.store.list('moderation-review')).toHaveLength(0);
  });

  it('records the full LLM failure for a simulated run', async () => {
    const input = randomUUID();
    const translation = randomUUID();
    const output = randomUUID();
    const failure = Object.assign(new Error('LLM returned invalid JSON: trailing content'), {
      name: 'LlmRequestError',
      details: {
        stage: 'json',
        providerUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-3.5-flash',
        schemaName: 'disqord_translation',
        attempt: 0,
        maxRetries: 0,
        retryable: true,
        contentPreview: '{"detectedLanguage":"zh"}\\n额外说明',
        parserError: 'Unexpected non-whitespace character after JSON',
      },
    });
    const setup = await fixture(
      [
        node(input, 'simulated-input'),
        node(translation, 'llm-translation', { prompt: '翻译', memoryMode: false }),
        node(output, 'chat-output', { sessionRole: 'target' }),
      ],
      [
        { id: randomUUID(), sourceNodeId: input, targetNodeId: translation },
        { id: randomUUID(), sourceNodeId: translation, targetNodeId: output },
      ],
      { translate: vi.fn(async () => { throw failure; }) },
    );

    await expect(
      setup.orchestrator.handleSimulatedInput(setup.blueprint.id, input, '你好'),
    ).rejects.toThrow('trailing content');

    const logs = (await setup.store.list<Record<string, unknown>>('trace-log')).map(
      (entry) => entry.value,
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'translation_failed', level: 'error' }),
        expect.objectContaining({
          event: 'llm_request_failed',
          details: expect.objectContaining({
            failure: expect.objectContaining({
              stage: 'json',
              contentPreview: expect.stringContaining('额外说明'),
            }),
          }),
        }),
        expect.objectContaining({
          event: 'blueprint_failed',
          details: expect.objectContaining({ simulatedInput: true }),
        }),
      ]),
    );
  });

  it('lets a real input finish at a simulated output without sending externally', async () => {
    const input = randomUUID();
    const fixed = randomUUID();
    const output = randomUUID();
    const setup = await fixture(
      [
        node(input, 'chat-input', { sessionRole: 'source' }),
        node(fixed, 'fixed-text', { text: '模拟结果' }),
        node(output, 'simulated-output'),
      ],
      [
        { id: randomUUID(), sourceNodeId: input, targetNodeId: fixed },
        { id: randomUUID(), sourceNodeId: fixed, targetNodeId: output },
      ],
      {},
    );

    await setup.orchestrator.handleNodeFrame({
      nodeId: setup.sourceSession.nodeId,
      nodeType: 'qq',
      kind: 'message.upload',
      payload: message(setup.sourceSession.nodeId),
      frameId: randomUUID(),
    });

    expect(setup.sendToNode).not.toHaveBeenCalled();
    const activities = (await setup.store.list<Record<string, unknown>>('blueprint-activity')).map(
      (entry) => entry.value,
    );
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: input }),
        expect.objectContaining({ nodeId: fixed, text: '模拟结果' }),
        expect.objectContaining({ nodeId: output, text: '模拟结果' }),
      ]),
    );
  });

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

  it('routes an unavailable image review to the blocked output even at a 100% threshold', async () => {
    const input = randomUUID();
    const moderation = randomUUID();
    const output = randomUUID();
    const blocked = randomUUID();
    const moderate = vi.fn(async () => ({
      violationScore: 1,
      categories: ['image-review-unavailable'],
      reason: '未配置图片审核模型',
      confidence: 1,
      model: 'image-review-unavailable',
    }));
    const setup = await fixture(
      [
        node(input, 'chat-input', { sessionRole: 'source' }),
        node(moderation, 'llm-moderation', { prompt: '审核图片', threshold: 1 }),
        node(output, 'chat-output', { sessionRole: 'target' }),
        node(blocked, 'discard'),
      ],
      [
        { id: randomUUID(), sourceNodeId: input, targetNodeId: moderation },
        {
          id: randomUUID(),
          sourceNodeId: moderation,
          sourceHandle: 'passed',
          targetNodeId: output,
        },
        {
          id: randomUUID(),
          sourceNodeId: moderation,
          sourceHandle: 'blocked',
          targetNodeId: blocked,
        },
      ],
      { moderate },
    );
    const incoming = {
      ...message(setup.sourceSession.nodeId),
      kind: 'image' as const,
      text: undefined,
      attachments: [
        {
          id: randomUUID(),
          mimeType: 'image/png',
          byteSize: 4,
          sha256: 'a'.repeat(64),
          sourceUrl: 'https://images.example.test/image.png',
        },
      ],
    };

    await setup.orchestrator.handleNodeFrame({
      nodeId: setup.sourceSession.nodeId,
      nodeType: 'qq',
      kind: 'message.upload',
      payload: incoming,
      frameId: randomUUID(),
    });

    expect(moderate).toHaveBeenCalledWith(
      '',
      '审核图片',
      expect.objectContaining({ imageReviewRequested: true, imageCount: 1 }),
    );
    expect(setup.sendToNode).not.toHaveBeenCalled();
    expect(await setup.store.list('moderation-review')).toHaveLength(0);
    const activities = (await setup.store.list<Record<string, unknown>>('blueprint-activity')).map(
      (entry) => entry.value,
    );
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: moderation, route: 'blocked', violationScore: 1 }),
        expect.objectContaining({ nodeId: blocked }),
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

  it('pauses at manual review and resumes from the selected output', async () => {
    const input = randomUUID();
    const review = randomUUID();
    const output = randomUUID();
    const blocked = randomUUID();
    const render = vi.fn(async (_message, _target, text) => [Buffer.from(text)]);
    const setup = await fixture(
      [
        node(input, 'chat-input', { sessionRole: 'source' }),
        node(review, 'manual-review'),
        node(output, 'chat-output', { sessionRole: 'target' }),
        node(blocked, 'discard'),
      ],
      [
        { id: randomUUID(), sourceNodeId: input, targetNodeId: review },
        {
          id: randomUUID(),
          sourceNodeId: review,
          sourceHandle: 'passed',
          targetNodeId: output,
        },
        {
          id: randomUUID(),
          sourceNodeId: review,
          sourceHandle: 'blocked',
          targetNodeId: blocked,
        },
      ],
      { render },
    );
    const incoming = message(setup.sourceSession.nodeId, '等待审核的消息');
    await setup.orchestrator.handleNodeFrame({
      nodeId: setup.sourceSession.nodeId,
      nodeType: 'qq',
      kind: 'message.upload',
      payload: incoming,
      frameId: randomUUID(),
    });

    expect(setup.sendToNode).not.toHaveBeenCalled();
    const reviews = await setup.store.list<Record<string, unknown>>('moderation-review');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.value).toMatchObject({
      status: 'pending',
      reason: '等待审核的消息',
      reviewNodeId: review,
    });

    await setup.orchestrator.handleReview(reviews[0]!.key, 'approve');

    expect(render).toHaveBeenCalledWith(incoming, setup.targetSession, '等待审核的消息', false);
    expect(setup.sendToNode).toHaveBeenCalledOnce();
    expect(
      (await setup.store.get<Record<string, unknown>>('moderation-review', reviews[0]!.key))?.value,
    ).toMatchObject({ status: 'approved' });
  });
});
