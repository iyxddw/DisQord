import { type SecureFrame, verifySecureFrameMac } from './crypto.js';

export class ReplayGuard {
  #lastSequence = 0;
  readonly #nodeId: string;
  readonly #sessionToken: string;
  readonly #now: () => number;
  readonly #maxClockSkewMs: number;

  constructor(
    nodeId: string,
    sessionToken: string,
    now: () => number = Date.now,
    maxClockSkewMs = 2 * 60 * 1_000,
    initialSequence = 0,
  ) {
    this.#nodeId = nodeId;
    this.#sessionToken = sessionToken;
    this.#now = now;
    this.#maxClockSkewMs = maxClockSkewMs;
    this.#lastSequence = initialSequence;
  }

  verify(frame: SecureFrame): void {
    if (frame.nodeId !== this.#nodeId) {
      throw new Error('Frame node identity does not match the authenticated connection.');
    }
    if (Math.abs(this.#now() - Date.parse(frame.createdAt)) > this.#maxClockSkewMs) {
      throw new Error('Frame timestamp is outside the allowed window.');
    }
    if (frame.sequence <= this.#lastSequence) {
      throw new Error('Frame sequence was replayed or delivered out of order.');
    }
    if (!verifySecureFrameMac(frame, this.#sessionToken)) {
      throw new Error('Frame MAC is invalid.');
    }
    this.#lastSequence = frame.sequence;
  }

  lastSequence(): number {
    return this.#lastSequence;
  }
}
