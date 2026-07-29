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
});
