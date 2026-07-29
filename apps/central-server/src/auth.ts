import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { z } from 'zod';

import { type StateStore } from './state-store.js';

const scrypt = promisify(scryptCallback);
const adminRecordSchema = z.object({
  salt: z.string(),
  passwordHash: z.string(),
  createdAt: z.string(),
});
const sessionRecordSchema = z.object({
  expiresAt: z.string(),
  createdAt: z.string(),
});

export class CentralAuthService {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  async isConfigured(): Promise<boolean> {
    return Boolean(await this.#store.get('auth', 'administrator'));
  }

  async setup(password: string): Promise<string> {
    if (await this.isConfigured()) throw new Error('Administrator is already configured.');
    validatePassword(password);
    const salt = randomBytes(16);
    const passwordHash = await derivePassword(password, salt);
    await this.#store.set('auth', 'administrator', {
      salt: salt.toString('base64'),
      passwordHash: passwordHash.toString('base64'),
      createdAt: new Date().toISOString(),
    });
    return await this.#createSession();
  }

  async login(password: string): Promise<string> {
    const entry = await this.#store.get('auth', 'administrator');
    if (!entry) throw new Error('Administrator has not been configured.');
    const admin = adminRecordSchema.parse(entry.value);
    const actual = await derivePassword(password, Buffer.from(admin.salt, 'base64'));
    const expected = Buffer.from(admin.passwordHash, 'base64');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error('Invalid administrator password.');
    }
    return await this.#createSession();
  }

  async authenticate(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const digest = digestToken(token);
    const entry = await this.#store.get('auth-session', digest);
    if (!entry) return false;
    const session = sessionRecordSchema.parse(entry.value);
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await this.#store.delete('auth-session', digest);
      return false;
    }
    return true;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.#store.delete('auth-session', digestToken(token));
  }

  async #createSession(): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.#store.set('auth-session', digestToken(token), {
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1_000).toISOString(),
    });
    return token;
  }
}

function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 256) {
    throw new Error('Administrator password must contain between 12 and 256 characters.');
  }
}

async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return (await scrypt(password, salt, 64)) as Buffer;
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
