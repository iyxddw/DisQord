import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertTaskTransition,
  createMessageIdempotencyKey,
  createProgramDescriptor,
  messageEnvelopeSchema,
} from './index.js';

describe('createProgramDescriptor', () => {
  it('keeps the central server role fixed', () => {
    expect(createProgramDescriptor('central-server')).toEqual({
      name: 'central-server',
      role: 'central',
    });
  });

  it('keeps platform node roles fixed', () => {
    expect(createProgramDescriptor('qq-node')).toMatchObject({
      role: 'platform-node',
      platform: 'qq',
    });
    expect(createProgramDescriptor('discord-node')).toMatchObject({
      role: 'platform-node',
      platform: 'discord',
    });
  });
});

describe('messageEnvelopeSchema', () => {
  const message = {
    schemaVersion: 1,
    eventId: randomUUID(),
    source: {
      nodeId: randomUUID(),
      platform: 'qq',
      spaceId: '10001',
      channelId: '10001',
      messageId: '90001',
    },
    sender: {
      id: '12345',
      displayName: '测试用户',
    },
    sentAt: new Date().toISOString(),
    kind: 'text',
    text: 'Hello',
    attachments: [],
    replyTo: {
      sourceMessageId: '89999',
      senderDisplayName: 'Earlier user',
      textPreview: 'Earlier message',
    },
    traceId: randomUUID(),
  } as const;

  it('accepts a normalized reply message', () => {
    expect(messageEnvelopeSchema.parse(message).replyTo?.sourceMessageId).toBe('89999');
  });

  it('creates a stable idempotency key independent of event ID', () => {
    const first = messageEnvelopeSchema.parse(message);
    const second = messageEnvelopeSchema.parse({ ...message, eventId: randomUUID() });

    expect(createMessageIdempotencyKey(first)).toBe(createMessageIdempotencyKey(second));
  });

  it('rejects an image message without attachments', () => {
    expect(() =>
      messageEnvelopeSchema.parse({ ...message, kind: 'image', text: undefined }),
    ).toThrow();
  });
});

describe('task state machine', () => {
  it('allows the expected happy-path transition', () => {
    expect(() => assertTaskTransition('received', 'blueprint_matched')).not.toThrow();
  });

  it('rejects skipping directly to acknowledged', () => {
    expect(() => assertTaskTransition('received', 'acknowledged')).toThrow(
      'Invalid task transition',
    );
  });
});
