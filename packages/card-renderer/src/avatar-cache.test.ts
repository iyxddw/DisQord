import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { AvatarCache } from './avatar-cache.js';

describe('avatar cache', () => {
  it('persists normalized avatars by a stable platform/user key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'disqord-avatar-'));
    try {
      const source = await sharp({
        create: {
          width: 320,
          height: 180,
          channels: 4,
          background: '#5865f2',
        },
      })
        .png()
        .toBuffer();
      const dataUri = `data:image/png;base64,${source.toString('base64')}`;
      const first = await new AvatarCache(directory).cacheDataUri(dataUri, 'qq:12345');
      const second = await new AvatarCache(directory).getCached('qq:12345');

      expect(first?.dataUri).toBe(second?.dataUri);
      expect(first?.dataUri).toMatch(/^data:image\/png;base64,/u);

      const metadata = await sharp(first!.bytes).metadata();
      expect(metadata.width).toBe(128);
      expect(metadata.height).toBe(128);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
