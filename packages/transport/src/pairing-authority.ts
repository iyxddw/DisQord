import { timingSafeEqual } from 'node:crypto';

import { platformSchema, type Platform } from '@disqord/shared';

import {
  createRandomToken,
  fingerprintPublicKey,
  hashSecret,
  type PairingRequest,
  verifyPairingRequestSignature,
} from './crypto.js';

interface PairingCodeRecord {
  readonly digest: string;
  readonly nodeType: Platform;
  readonly expiresAt: number;
  consumed: boolean;
}

export interface NodeSession {
  readonly nodeId: string;
  readonly nodeType: Platform;
  readonly publicKeyFingerprint: string;
  readonly tokenDigest: string;
  revoked: boolean;
}

export interface PairingCode {
  readonly code: string;
  readonly expiresAt: string;
  readonly nodeType: Platform;
}

export interface PairingAcceptance {
  readonly nodeId: string;
  readonly nodeType: Platform;
  readonly sessionToken: string;
  readonly publicKeyFingerprint: string;
}

export class PairingAuthority {
  readonly #codes = new Map<string, PairingCodeRecord>();
  readonly #sessions = new Map<string, NodeSession>();
  readonly #pepper: string;
  readonly #now: () => number;

  constructor(pepper: string, now: () => number = Date.now) {
    if (pepper.length < 32) {
      throw new Error('Pairing pepper must contain at least 32 characters.');
    }
    this.#pepper = pepper;
    this.#now = now;
  }

  createCode(nodeType: Platform, ttlMs = 10 * 60 * 1_000): PairingCode {
    platformSchema.parse(nodeType);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60 * 1_000) {
      throw new Error('Pairing code TTL is outside the allowed range.');
    }

    const code = createRandomToken(12);
    const digest = hashSecret(code, this.#pepper);
    const expiresAt = this.#now() + ttlMs;
    this.#codes.set(digest, { digest, nodeType, expiresAt, consumed: false });
    return { code, expiresAt: new Date(expiresAt).toISOString(), nodeType };
  }

  accept(request: PairingRequest): PairingAcceptance {
    this.#validateRequest(request);
    if (!request.pairingCode) throw new Error('Pairing code is required.');

    const codeDigest = hashSecret(request.pairingCode, this.#pepper);
    const codeRecord = this.#codes.get(codeDigest);
    if (
      !codeRecord ||
      codeRecord.consumed ||
      codeRecord.expiresAt < this.#now() ||
      codeRecord.nodeType !== request.nodeType
    ) {
      throw new Error('Pairing code is invalid, expired, consumed, or for another node type.');
    }

    codeRecord.consumed = true;
    return this.#createSession(request);
  }

  register(request: PairingRequest): PairingAcceptance {
    this.#validateRequest(request);
    if (request.pairingCode) throw new Error('Automatic registration must not include a code.');
    const existing = this.#sessions.get(request.nodeId);
    const fingerprint = fingerprintPublicKey(request.publicKeyPem);
    if (existing && existing.publicKeyFingerprint !== fingerprint) {
      throw new Error('Node ID is already registered with another identity.');
    }
    return this.#createSession(request);
  }

  #validateRequest(request: PairingRequest): void {
    const requestTime = Date.parse(request.createdAt);
    if (!Number.isFinite(requestTime) || Math.abs(this.#now() - requestTime) > 5 * 60 * 1_000) {
      throw new Error('Pairing request timestamp is outside the allowed window.');
    }
    if (!verifyPairingRequestSignature(request)) {
      throw new Error('Pairing request signature is invalid.');
    }
  }

  #createSession(request: PairingRequest): PairingAcceptance {
    const sessionToken = createRandomToken(32);
    const session: NodeSession = {
      nodeId: request.nodeId,
      nodeType: request.nodeType,
      publicKeyFingerprint: fingerprintPublicKey(request.publicKeyPem),
      tokenDigest: hashSecret(sessionToken, this.#pepper),
      revoked: false,
    };
    this.#sessions.set(request.nodeId, session);

    return {
      nodeId: session.nodeId,
      nodeType: session.nodeType,
      sessionToken,
      publicKeyFingerprint: session.publicKeyFingerprint,
    };
  }

  authenticate(nodeId: string, nodeType: Platform, sessionToken: string): NodeSession {
    const session = this.#sessions.get(nodeId);
    const candidateDigest = hashSecret(sessionToken, this.#pepper);
    if (
      !session ||
      session.revoked ||
      session.nodeType !== nodeType ||
      !safeTextEqual(candidateDigest, session.tokenDigest)
    ) {
      throw new Error('Node authentication failed.');
    }
    return { ...session };
  }

  revoke(nodeId: string): void {
    const session = this.#sessions.get(nodeId);
    if (!session) {
      throw new Error(`Unknown node ${nodeId}.`);
    }
    session.revoked = true;
  }

  restoreSession(session: NodeSession): void {
    platformSchema.parse(session.nodeType);
    if (!session.nodeId || !session.publicKeyFingerprint || !session.tokenDigest) {
      throw new Error('Persisted node session is incomplete.');
    }
    this.#sessions.set(session.nodeId, { ...session });
  }

  getSession(nodeId: string): NodeSession | undefined {
    const session = this.#sessions.get(nodeId);
    return session ? { ...session } : undefined;
  }

  listSessions(): NodeSession[] {
    return [...this.#sessions.values()].map((session) => ({ ...session }));
  }
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
