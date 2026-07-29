import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { downloadExternalImage } from './media.js';

describe('downloadExternalImage', () => {
  it('rejects loopback and private network targets before fetching', async () => {
    const fetchImplementation = vi.fn();
    await expect(
      downloadExternalImage('http://127.0.0.1/metadata', { fetchImplementation }),
    ).rejects.toThrow('private or reserved');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('normalizes WebP images to PNG for portable SVG embedding', async () => {
    const webp = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: '#5865f2',
      },
    })
      .webp()
      .toBuffer();
    const fetchImplementation = vi.fn(async () => {
      return new Response(webp, {
        headers: { 'content-type': 'image/webp' },
      });
    }) as unknown as typeof fetch;

    const image = await downloadExternalImage('https://1.1.1.1/avatar.webp', {
      fetchImplementation,
    });

    expect(image.mimeType).toBe('image/png');
    expect(image.dataUri).toMatch(/^data:image\/png;base64,/u);
    expect((await sharp(image.bytes).metadata()).format).toBe('png');
  });
});
