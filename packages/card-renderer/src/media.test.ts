import { describe, expect, it, vi } from 'vitest';

import { downloadExternalImage } from './media.js';

describe('downloadExternalImage', () => {
  it('rejects loopback and private network targets before fetching', async () => {
    const fetchImplementation = vi.fn();
    await expect(
      downloadExternalImage('http://127.0.0.1/metadata', { fetchImplementation }),
    ).rejects.toThrow('private or reserved');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
