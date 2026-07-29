import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ChatSessionVerificationService, InMemoryChatSessionRepository } from './service.js';

const secret = 'chat-session-test-secret-that-is-longer-than-32-characters';

describe('ChatSessionVerificationService', () => {
  it('saves a chat only as verified after the delivered code is filled back', async () => {
    const repository = new InMemoryChatSessionRepository();
    const service = new ChatSessionVerificationService(repository, secret);
    const session = service.addCandidate({
      nodeId: randomUUID(),
      platform: 'qq',
      externalId: '123456',
      spaceId: '123456',
      displayName: '测试群',
    });
    let deliveredCode = '';
    await service.sendVerification(session.id, async (code) => {
      deliveredCode = code;
    });

    expect(repository.getSession(session.id)?.status).toBe('pending');
    expect(service.verify(session.id, deliveredCode).status).toBe('verified');
  });

  it('rate limits resend attempts', async () => {
    const repository = new InMemoryChatSessionRepository();
    const service = new ChatSessionVerificationService(repository, secret);
    const session = service.addCandidate({
      nodeId: randomUUID(),
      platform: 'discord',
      externalId: 'channel-1',
      spaceId: 'guild-1',
      displayName: 'general',
    });
    const sender = vi.fn(async () => undefined);

    await service.sendVerification(session.id, sender);
    await expect(service.sendVerification(session.id, sender)).rejects.toThrow('rate limited');
  });

  it('locks verification after five incorrect attempts', async () => {
    const repository = new InMemoryChatSessionRepository();
    const service = new ChatSessionVerificationService(repository, secret);
    const session = service.addCandidate({
      nodeId: randomUUID(),
      platform: 'qq',
      externalId: '123456',
      spaceId: '123456',
      displayName: '测试群',
    });
    await service.sendVerification(session.id, async () => undefined);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => service.verify(session.id, 'WRONGCODE')).toThrow('incorrect');
    }
    expect(() => service.verify(session.id, 'WRONGCODE')).toThrow('locked');
  });
});
