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
          content: 'Previous <:thonk:1132907705724575777>',
        },
      },
      randomUUID(),
    );

    expect(message).toMatchObject({
      kind: 'mixed',
      replyTo: {
        sourceMessageId: '90',
        textPreview: 'Previous <:thonk:1132907705724575777>',
        customEmojis: [
          {
            token: '<:thonk:1132907705724575777>',
            sourceUrl:
              'https://cdn.discordapp.com/emojis/1132907705724575777.png?size=64&quality=lossless',
          },
        ],
      },
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

  it('replaces Discord user mention tags with the resolved display name', () => {
    const message = normalizeDiscordMessage(
      {
        ...baseMessage,
        content: '<@736128943861661818> 常见问题',
        mentions: [{ id: '736128943861661818', displayName: '真实昵称' }],
        referencedMessage: {
          id: '90',
          authorDisplayName: 'Bob',
          content: '<@!736128943861661818> faq',
          mentions: [{ id: '736128943861661818', displayName: '真实昵称' }],
        },
      },
      randomUUID(),
    );

    expect(message).toMatchObject({
      text: '@真实昵称 常见问题',
      replyTo: { textPreview: '@真实昵称 faq' },
    });
  });

  it('removes a mention of the Discord bot from the message body', () => {
    const message = normalizeDiscordMessage(
      {
        ...baseMessage,
        content: '是这样的啊 <@!999> ',
        mentions: [{ id: '999', displayName: '机器人' }],
      },
      randomUUID(),
      '999',
    );

    expect(message?.text).toBe('是这样的啊');
  });

  it('extracts static and animated custom emoji image sources', () => {
    const message = normalizeDiscordMessage(
      {
        ...baseMessage,
        content: '前 <:phigros:1094607105127891054> 后 <a:dance:1234567890>',
      },
      randomUUID(),
    );

    expect(message?.customEmojis).toEqual([
      {
        token: '<:phigros:1094607105127891054>',
        name: 'phigros',
        id: '1094607105127891054',
        animated: false,
        sourceUrl:
          'https://cdn.discordapp.com/emojis/1094607105127891054.png?size=64&quality=lossless',
      },
      {
        token: '<a:dance:1234567890>',
        name: 'dance',
        id: '1234567890',
        animated: true,
        sourceUrl: 'https://cdn.discordapp.com/emojis/1234567890.gif?size=64&quality=lossless',
      },
    ]);
  });

  it('ignores a Discord message that only mentions the bot', () => {
    expect(
      normalizeDiscordMessage(
        {
          ...baseMessage,
          content: '<@999>',
          mentions: [{ id: '999', displayName: '机器人' }],
        },
        randomUUID(),
        '999',
      ),
    ).toBeUndefined();
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
