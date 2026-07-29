import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { normalizeDiscordMessage, type DiscordMessageSnapshot } from './normalize.js';

const baseMessage: DiscordMessageSnapshot = {
  id: '100',
  guildId: '200',
  channelId: '300',
  createdAt: new Date().toISOString(),
  content: 'Hello',
  type: 0,
  author: {
    id: '400',
    displayName: 'Alice',
    avatarUrl: 'https://example.test/avatar.png',
    bot: false,
  },
  attachments: [],
  stickerCount: 0,
};

describe('normalizeDiscordMessage', () => {
  it('normalizes an image reply and preserves its reference', () => {
    const message = normalizeDiscordMessage(
      {
        ...baseMessage,
        attachments: [
          {
            id: 'image-1',
            name: 'photo.png',
            contentType: 'image/png',
            size: 1024,
            url: 'https://example.test/photo.png',
            width: 640,
            height: 480,
          },
        ],
        referencedMessage: {
          id: '90',
          authorDisplayName: 'Bob',
          content: 'Previous message',
        },
      },
      randomUUID(),
    );

    expect(message).toMatchObject({
      kind: 'mixed',
      replyTo: { sourceMessageId: '90', textPreview: 'Previous message' },
      attachments: [{ mimeType: 'image/png', byteSize: 1024 }],
    });
  });

  it('marks non-image files as unsupported', () => {
    const message = normalizeDiscordMessage(
      {
        ...baseMessage,
        attachments: [
          {
            id: 'file-1',
            name: 'document.pdf',
            contentType: 'application/pdf',
            size: 2048,
            url: 'https://example.test/document.pdf',
          },
        ],
      },
      randomUUID(),
    );

    expect(message).toMatchObject({ kind: 'unsupported', unsupportedType: 'file' });
  });

  it('ignores Discord bot messages to prevent loops', () => {
    expect(
      normalizeDiscordMessage(
        {
          ...baseMessage,
          author: { ...baseMessage.author, bot: true },
        },
        randomUUID(),
      ),
    ).toBeUndefined();
  });
});
