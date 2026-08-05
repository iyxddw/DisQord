import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import sharp from 'sharp';

import { downloadExternalImage, type DownloadedImage } from './media.js';

const avatarDataUriPattern =
  /^data:image\/(?:png|jpeg|webp|gif);base64,(?<payload>[A-Za-z0-9+/]+={0,2})$/u;

/**
 * Small, filesystem-backed avatar cache.  Avatars are immutable CDN objects
 * for the lifetime of a message, so keeping the normalized PNG by URL avoids
 * downloading the same profile image for every forwarded message.
 */
export class AvatarCache {
  readonly #directory: string;
  readonly #maxAgeMs: number;
  readonly #inFlight = new Map<string, Promise<DownloadedImage | undefined>>();

  constructor(directory: string, maxAgeMs = 7 * 24 * 60 * 60 * 1_000) {
    this.#directory = directory;
    this.#maxAgeMs = maxAgeMs;
  }

  async get(url: string): Promise<DownloadedImage | undefined> {
    const existing = this.#inFlight.get(url);
    if (existing) return await existing;
    const task = this.#load(url);
    this.#inFlight.set(url, task);
    try {
      return await task;
    } finally {
      if (this.#inFlight.get(url) === task) this.#inFlight.delete(url);
    }
  }

  async getCached(key: string): Promise<DownloadedImage | undefined> {
    return await this.#readCached(this.#keyFile(key));
  }

  /**
   * Cache an avatar that was already transferred by the central server.
   * Client-side render requests intentionally carry the avatar as a data URI,
   * so this path never makes another network request.  The normalized PNG is
   * returned to the renderer and can be reused by later deliveries.
   */
  async cacheDataUri(dataUri: string, stableKey?: string): Promise<DownloadedImage | undefined> {
    const key = stableKey ? `stable-key:${stableKey}` : `data-uri:${dataUri}`;
    const existing = this.#inFlight.get(key);
    if (existing) return await existing;
    const task = this.#loadDataUri(dataUri, stableKey);
    this.#inFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (this.#inFlight.get(key) === task) this.#inFlight.delete(key);
    }
  }

  async #load(url: string): Promise<DownloadedImage | undefined> {
    // Include the output contract in the key.  This invalidates cache entries
    // created before the 128x128 client-rendering contract was introduced;
    // otherwise a previously cached full-size avatar would keep crossing the
    // central WebSocket unchanged.
    const cacheKey = createHash('sha256').update(`avatar-v2-128x128|${url}`).digest('hex');
    const file = join(this.#directory, `${cacheKey}.png`);
    const cached = await this.#readCached(file);
    if (cached) return cached;

    try {
      const downloaded = await downloadExternalImage(url, {
        maxBytes: 1 * 1024 * 1024,
        resize: { width: 128, height: 128, fit: 'cover' },
      });
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, downloaded.bytes);
      await rename(temporary, file);
      return downloaded;
    } catch {
      // Avatars are decorative; rendering can safely fall back to initials.
      await unlink(file).catch(() => undefined);
      return undefined;
    }
  }

  async #loadDataUri(dataUri: string, stableKey?: string): Promise<DownloadedImage | undefined> {
    const match = avatarDataUriPattern.exec(dataUri);
    if (!match?.groups?.payload) return undefined;

    let sourceBytes: Buffer;
    try {
      sourceBytes = Buffer.from(match.groups.payload, 'base64');
    } catch {
      return undefined;
    }
    if (!sourceBytes.length || sourceBytes.length > 512 * 1024) return undefined;

    const cacheKey = createHash('sha256')
      .update(
        stableKey ? `avatar-key-v1-128x128|${stableKey}` : `avatar-data-v1-128x128|${dataUri}`,
      )
      .digest('hex');
    const file = join(this.#directory, `${cacheKey}.png`);
    const cached = await this.#readCached(file);
    if (cached) return cached;

    try {
      const bytes = await sharp(sourceBytes, { animated: false })
        .resize(128, 128, { fit: 'cover' })
        .png()
        .toBuffer();
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, file);
      return {
        bytes,
        mimeType: 'image/png',
        dataUri: `data:image/png;base64,${bytes.toString('base64')}`,
      };
    } catch {
      await unlink(file).catch(() => undefined);
      return undefined;
    }
  }

  async #readCached(file: string): Promise<DownloadedImage | undefined> {
    try {
      const fileStat = await stat(file);
      if (Date.now() - fileStat.mtimeMs > this.#maxAgeMs) return undefined;
      const bytes = await readFile(file);
      return {
        bytes,
        mimeType: 'image/png',
        dataUri: `data:image/png;base64,${bytes.toString('base64')}`,
      };
    } catch {
      // A missing, stale, or partially written cache entry is ignored.
      return undefined;
    }
  }

  #keyFile(key: string): string {
    const cacheKey = createHash('sha256').update(`avatar-key-v1-128x128|${key}`).digest('hex');
    return join(this.#directory, `${cacheKey}.png`);
  }
}
