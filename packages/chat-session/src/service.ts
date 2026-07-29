import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { chatSessionSchema, type ChatSession, type Platform } from '@disqord/shared';

export interface VerificationRecord {
  readonly sessionId: string;
  readonly codeDigest: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  attemptCount: number;
  consumedAt?: number;
}

export interface ChatSessionCandidate {
  readonly nodeId: string;
  readonly platform: Platform;
  readonly externalId: string;
  readonly spaceId: string;
  readonly displayName: string;
}

export interface ChatSessionRepository {
  saveSession(session: ChatSession): void;
  getSession(id: string): ChatSession | undefined;
  listSessions(): readonly ChatSession[];
  saveVerification(record: VerificationRecord): void;
  getActiveVerification(sessionId: string): VerificationRecord | undefined;
}

export class InMemoryChatSessionRepository implements ChatSessionRepository {
  readonly #sessions = new Map<string, ChatSession>();
  readonly #verifications = new Map<string, VerificationRecord>();

  saveSession(session: ChatSession): void {
    this.#sessions.set(session.id, structuredClone(session));
  }

  getSession(id: string): ChatSession | undefined {
    const session = this.#sessions.get(id);
    return session ? structuredClone(session) : undefined;
  }

  listSessions(): readonly ChatSession[] {
    return [...this.#sessions.values()].map((session) => structuredClone(session));
  }

  saveVerification(record: VerificationRecord): void {
    this.#verifications.set(record.sessionId, { ...record });
  }

  getActiveVerification(sessionId: string): VerificationRecord | undefined {
    const record = this.#verifications.get(sessionId);
    return record ? { ...record } : undefined;
  }
}

export class ChatSessionVerificationService {
  readonly #lastSendAt = new Map<string, number>();
  readonly #repository: ChatSessionRepository;
  readonly #secret: string;
  readonly #now: () => number;

  constructor(repository: ChatSessionRepository, secret: string, now: () => number = Date.now) {
    if (secret.length < 32) {
      throw new Error('Chat session verification secret must be at least 32 characters.');
    }
    this.#repository = repository;
    this.#secret = secret;
    this.#now = now;
  }

  addCandidate(candidate: ChatSessionCandidate): ChatSession {
    const now = new Date(this.#now()).toISOString();
    const session = chatSessionSchema.parse({
      id: randomUUID(),
      ...candidate,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    this.#repository.saveSession(session);
    return session;
  }

  async sendVerification(
    sessionId: string,
    sender: (code: string, expiresAt: string) => Promise<void>,
  ): Promise<{ expiresAt: string }> {
    const session = this.#requireSession(sessionId);
    if (session.status === 'disabled') {
      throw new Error('Disabled chat sessions cannot be verified.');
    }
    const lastSent = this.#lastSendAt.get(sessionId);
    if (lastSent && this.#now() - lastSent < 30_000) {
      throw new Error('Verification code resend is rate limited.');
    }

    const code = randomBytes(6).toString('base64url').toUpperCase();
    const expiresAt = this.#now() + 10 * 60 * 1_000;
    const record: VerificationRecord = {
      sessionId,
      codeDigest: this.#digest(code),
      expiresAt,
      createdAt: this.#now(),
      attemptCount: 0,
    };
    await sender(code, new Date(expiresAt).toISOString());
    this.#repository.saveVerification(record);
    this.#lastSendAt.set(sessionId, this.#now());
    return { expiresAt: new Date(expiresAt).toISOString() };
  }

  verify(sessionId: string, code: string): ChatSession {
    const session = this.#requireSession(sessionId);
    const verification = this.#repository.getActiveVerification(sessionId);
    if (!verification || verification.consumedAt || verification.expiresAt < this.#now()) {
      throw new Error('Verification code is missing, expired, or already consumed.');
    }
    if (verification.attemptCount >= 5) {
      throw new Error('Verification is locked after too many failed attempts.');
    }

    verification.attemptCount += 1;
    const candidate = Buffer.from(this.#digest(code.trim().toUpperCase()));
    const expected = Buffer.from(verification.codeDigest);
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      this.#repository.saveVerification(verification);
      throw new Error('Verification code is incorrect.');
    }

    verification.consumedAt = this.#now();
    this.#repository.saveVerification(verification);
    const now = new Date(this.#now()).toISOString();
    const verified = chatSessionSchema.parse({
      ...session,
      status: 'verified',
      verifiedAt: now,
      updatedAt: now,
    });
    this.#repository.saveSession(verified);
    return verified;
  }

  #requireSession(sessionId: string): ChatSession {
    const session = this.#repository.getSession(sessionId);
    if (!session) throw new Error(`Unknown chat session ${sessionId}.`);
    return session;
  }

  #digest(code: string): string {
    return createHmac('sha256', this.#secret).update(code).digest('hex');
  }
}
