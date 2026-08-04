import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { downloadExternalImage, type DownloadedImage } from './media.js';

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

  async #load(url: string): Promise<DownloadedImage | undefined> {
    const file = join(this.#directory, `${createHash('sha256').update(url).digest('hex')}.png`);
    try {
      const fileStat = await stat(file);
      if (Date.now() - fileStat.mtimeMs <= this.#maxAgeMs) {
        const bytes = await readFile(file);
        return {
          bytes,
          mimeType: 'image/png',
          dataUri: `data:image/png;base64,${bytes.toString('base64')}`,
        };
      }
    } catch {
      // A missing or stale cache entry is refreshed below.
    }

    try {
      const downloaded = await downloadExternalImage(url, { maxBytes: 1 * 1024 * 1024 });
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
}
