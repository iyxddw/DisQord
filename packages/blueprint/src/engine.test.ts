import { randomUUID } from 'node:crypto';

import { type BlueprintVersion, type MessageEnvelope } from '@disqord/shared';
import { describe, expect, it } from 'vitest';

import { simulateBlueprint, validateBlueprint } from './engine.js';

const inputSession = randomUUID();
const outputA = randomUUID();
const outputB = randomUUID();

function createBlueprint(): BlueprintVersion {
  const input = randomUUID();
  const filter = randomUUID();
  const split = randomUUID();
  const firstOutput = randomUUID();
  const secondOutput = randomUUID();
  return {
    id: randomUUID(),
    blueprintId: randomUUID(),
    version: 1,
    status: 'published',
    nodes: [
      {
        id: input,
        type: 'chat-input',
        position: { x: 0, y: 0 },
        config: { sessionId: inputSession },
      },
      {
        id: filter,
        type: 'message-type-filter',
        position: { x: 200, y: 0 },
        config: { allowedKinds: ['text', 'mixed'] },
      },
      { id: split, type: 'split', position: { x: 400, y: 0 }, config: {} },
      {
        id: firstOutput,
        type: 'chat-output',
        position: { x: 600, y: -100 },
        config: { sessionId: outputA },
      },
      {
        id: secondOutput,
        type: 'chat-output',
        position: { x: 600, y: 100 },
        config: { sessionId: outputB },
      },
    ],
    edges: [
      { id: randomUUID(), sourceNodeId: input, targetNodeId: filter },
      { id: randomUUID(), sourceNodeId: filter, targetNodeId: split },
      { id: randomUUID(), sourceNodeId: split, targetNodeId: firstOutput },
      { id: randomUUID(), sourceNodeId: split, targetNodeId: secondOutput },
    ],
    createdBy: randomUUID(),
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
  };
}

const textMessage: MessageEnvelope = {
  schemaVersion: 1,
  eventId: randomUUID(),
  source: {
    nodeId: randomUUID(),
    platform: 'qq',
    spaceId: 'group',
    channelId: 'group',
    messageId: 'message',
  },
  sender: { id: 'user', displayName: 'User' },
  sentAt: new Date().toISOString(),
  kind: 'text',
  text: 'hello',
  attachments: [],
  traceId: randomUUID(),
};

describe('blueprint validation and simulation', () => {
  it('supports one-to-many routing', () => {
    const blueprint = createBlueprint();
    const result = simulateBlueprint(blueprint, inputSession, textMessage, {
      isVerifiedSession: () => true,
    });
    expect(result.outputSessionIds.sort()).toEqual([outputA, outputB].sort());
  });

  it('rejects unverified chat sessions', () => {
    const result = validateBlueprint(createBlueprint(), {
      isVerifiedSession: (id) => id !== outputB,
    });
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'UNVERIFIED_SESSION' }));
  });

  it('rejects cycles', () => {
    const blueprint = createBlueprint();
    const lastOutput = blueprint.nodes.at(-1)!;
    const firstInput = blueprint.nodes[0]!;
    blueprint.edges.push({
      id: randomUUID(),
      sourceNodeId: lastOutput.id,
      targetNodeId: firstInput.id,
    });
    const result = validateBlueprint(blueprint, { isVerifiedSession: () => true });
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'CYCLE' }));
  });

  it('validates moderation thresholds and named outputs', () => {
    const blueprint = createBlueprint();
    const moderationId = randomUUID();
    blueprint.nodes.push({
      id: moderationId,
      type: 'llm-moderation',
      position: { x: 500, y: 200 },
      config: { prompt: '评估违规分数', threshold: 0.5 },
    });
    blueprint.edges.push({
      id: randomUUID(),
      sourceNodeId: moderationId,
      targetNodeId: blueprint.nodes.at(-2)!.id,
    });

    expect(validateBlueprint(blueprint, { isVerifiedSession: () => true }).errors).toContainEqual(
      expect.objectContaining({ code: 'INVALID_MODERATION_EDGE' }),
    );

    blueprint.edges.at(-1)!.sourceHandle = 'passed';
    expect(
      validateBlueprint(blueprint, { isVerifiedSession: () => true }).errors,
    ).not.toContainEqual(expect.objectContaining({ code: 'INVALID_MODERATION_EDGE' }));
  });
});
