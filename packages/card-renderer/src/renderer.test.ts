import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { buildMessageCardSvg, renderMessageCards } from './renderer.js';

describe('message card renderer', () => {
  it('renders a PNG with reply context and a translucent original section', async () => {
    const input = {
      sourcePlatform: 'qq' as const,
      targetLanguage: 'en' as const,
      sourceName: '测试群',
      senderName: 'Alice',
      sentAt: '2026-07-29 18:00',
      primaryText: 'This is the translated message.',
      originalText: '这是原始消息。',
      reply: {
        senderName: 'Bob',
        textPreview: 'Earlier message',
      },
      images: [],
      traceLabel: 'abc123',
    };
    const svg = buildMessageCardSvg(input);
    expect(svg).toContain('fill-opacity="0.10"');
    expect(svg).toContain('>ORIGINAL</text>');
    expect(svg).not.toContain('>原文</text>');
    expect(svg).toContain('Earlier message');

    const [png] = await renderMessageCards(input);
    const metadata = await sharp(png).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1_000);
  });

  it('paginates very long translated content', async () => {
    const cards = await renderMessageCards({
      sourcePlatform: 'discord',
      sourceName: 'general',
      senderName: 'Long user',
      sentAt: '2026-07-29 18:00',
      primaryText: 'long message '.repeat(1_000),
      originalText: '原文'.repeat(2_000),
      images: [],
    });
    expect(cards.length).toBeGreaterThan(1);
  });

  it('uses only Chinese interface labels for QQ targets', () => {
    const svg = buildMessageCardSvg({
      sourcePlatform: 'discord',
      targetLanguage: 'zh',
      sourceName: 'general',
      senderName: 'Alice',
      sentAt: '2026-07-29 18:00',
      primaryText: '',
      originalText: 'hello',
      unsupportedType: 'record',
      images: [],
    });

    expect(svg).toContain('>原文</text>');
    expect(svg).toContain('不支持的消息');
    expect(svg).not.toContain('ORIGINAL');
    expect(svg).not.toContain('Unsupported message');
  });

  it('renders reply images and a localized fallback when no preview is available', () => {
    const withImage = buildMessageCardSvg({
      sourcePlatform: 'qq',
      targetLanguage: 'en',
      sourceName: 'group',
      senderName: '😀',
      sentAt: '2026-07-29 18:00',
      primaryText: 'reply',
      reply: {
        senderName: 'Previous user',
        imagePreview: 'data:image/png;base64,aGVsbG8=',
      },
      images: [],
    });
    expect(withImage).toContain('Noto Color Emoji');
    expect(withImage).toContain(
      'font-family: "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei"',
    );
    expect(withImage.indexOf('Noto Sans SC')).toBeLessThan(withImage.indexOf('Noto Color Emoji'));
    expect(withImage).toContain('data:image/png;base64,aGVsbG8=');
    expect(withImage).not.toContain('Preview unavailable');

    const withoutPreview = buildMessageCardSvg({
      sourcePlatform: 'discord',
      targetLanguage: 'zh',
      sourceName: 'channel',
      senderName: 'Alice',
      sentAt: '2026-07-29 18:00',
      primaryText: '回复',
      reply: { senderName: '被回复用户' },
      images: [],
    });
    expect(withoutPreview).toContain('无可用预览');
  });

  it('renders a central Base64 spec locally with avatar and attachments', async () => {
    const image = `data:image/png;base64,${(
      await sharp({
        create: {
          width: 12,
          height: 8,
          channels: 4,
          background: '#43d3c4',
        },
      })
        .png()
        .toBuffer()
    ).toString('base64')}`;

    const [png] = await renderMessageCards({
      sourcePlatform: 'qq',
      targetLanguage: 'zh',
      sourceName: '测试群',
      senderName: '彩色 🐎',
      senderAvatar: image,
      sentAt: '2026-08-05 12:00',
      primaryText: '本地合成 🐎',
      originalText: 'original',
      images: [{ dataUri: image, width: 12, height: 8 }],
      traceLabel: 'local-render',
    });

    const metadata = await sharp(png).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1_000);
    expect(png.byteLength).toBeGreaterThan(1_000);
  });
});
