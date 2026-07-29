import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createPairingRequest,
  createSecureFrame,
  generateNodeIdentity,
  PairingAuthority,
  ReplayGuard,
} from './index.js';

const pepper = 'a-secure-test-pepper-that-is-longer-than-32-characters';

describe('PairingAuthority', () => {
  it('automatically registers a signed client identity without a pre-issued code', () => {
    const authority = new PairingAuthority(pepper);
    const identity = generateNodeIdentity('discord');
    const accepted = authority.register(createPairingRequest(identity));

    expect(authority.authenticate(identity.nodeId, 'discord', accepted.sessionToken)).toMatchObject(
      {
        nodeId: identity.nodeId,
        nodeType: 'discord',
        revoked: false,
      },
    );
  });

  it('binds a one-time code to the requested node type', () => {
    const authority = new PairingAuthority(pepper);
    const code = authority.createCode('qq');
    const discordIdentity = generateNodeIdentity('discord');

    expect(() => authority.accept(createPairingRequest(discordIdentity, code.code))).toThrow(
      'another node type',
    );
  });

  it('accepts a signed request once and authenticates the resulting session', () => {
    const authority = new PairingAuthority(pepper);
    const code = authority.createCode('qq');
    const identity = generateNodeIdentity('qq');
    const request = createPairingRequest(identity, code.code);
    const accepted = authority.accept(request);

    expect(authority.authenticate(identity.nodeId, 'qq', accepted.sessionToken)).toMatchObject({
      nodeId: identity.nodeId,
      nodeType: 'qq',
      revoked: false,
    });
    expect(() => authority.accept(request)).toThrow('consumed');
  });

  it('rejects expired pairing requests', () => {
    let now = Date.now();
    const authority = new PairingAuthority(pepper, () => now);
    const code = authority.createCode('qq');
    const request = createPairingRequest(generateNodeIdentity('qq'), code.code);
    now += 11 * 60 * 1_000;

    expect(() => authority.accept(request)).toThrow('timestamp');
  });
});

describe('secure frames', () => {
  it('accepts ordered authenticated frames', () => {
    const nodeId = randomUUID();
    const token = 'node-session-token';
    const guard = new ReplayGuard(nodeId, token);
    const frame = createSecureFrame(
      {
        frameId: randomUUID(),
        nodeId,
        sequence: 1,
        createdAt: new Date().toISOString(),
        kind: 'message.upload',
        payload: { messageId: '100' },
      },
      token,
    );

    expect(() => guard.verify(frame)).not.toThrow();
    expect(guard.lastSequence()).toBe(1);
  });

  it('rejects replay and tampering', () => {
    const nodeId = randomUUID();
    const token = 'node-session-token';
    const guard = new ReplayGuard(nodeId, token);
    const frame = createSecureFrame(
      {
        frameId: randomUUID(),
        nodeId,
        sequence: 1,
        createdAt: new Date().toISOString(),
        kind: 'message.upload',
        payload: { messageId: '100' },
      },
      token,
    );
    guard.verify(frame);

    expect(() => guard.verify(frame)).toThrow('replayed');

    const secondGuard = new ReplayGuard(nodeId, token);
    expect(() =>
      secondGuard.verify({
        ...frame,
        payload: { messageId: 'tampered' },
      }),
    ).toThrow('MAC');
  });
});
