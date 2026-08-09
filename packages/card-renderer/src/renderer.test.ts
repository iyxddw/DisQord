import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { buildMessageCardSvg, renderMessageCards } from './renderer.js';

/** Reads one RGB pixel from a rendered PNG. */
async function readRgbPixel(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const raw = await sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer();
  return [raw[0]!, raw[1]!, raw[2]!];
}

/** A PNG whose pixel color encodes its source row: `rgb(y & 0xff, (y >> 8) & 0xff, 0)`. */
async function rowEncodedPng(width: number, height: number): Promise<string> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const base = y * width * 3;
    for (let x = 0; x < width; x += 1) {
      const offset = base + x * 3;
      raw[offset] = y & 0xff;
      raw[offset + 1] = (y >> 8) & 0xff;
    }
  }
  const png = await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** True when any pixel is strongly red, which only the 不可回复 badge produces on a plain card. */
async function hasRedPixel(png: Buffer): Promise<boolean> {
  const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < data.length; offset += 3) {
    const r = data[offset]!;
    const g = data[offset + 1]!;
    const b = data[offset + 2]!;
    if (r - g > 20 && r - b > 20) return true;
  }
  return false;
}

describe('message card renderer', () => {
  it('renders different local palettes for different theme ids', async () => {
    const base = {
      sourcePlatform: 'qq' as const,
      sourceName: '测试群',
      senderName: 'Alice',
      sentAt: '2026-08-09 12:00',
      primaryText: '主题测试',
      images: [],
    };
    const [dark] = await renderMessageCards({ ...base, themeId: 'midnight' });
    const [light] = await renderMessageCards({ ...base, themeId: 'mint-support' });
    expect(await readRgbPixel(dark!, 500, 20)).not.toEqual(await readRgbPixel(light!, 500, 20));
  });

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

  it('renders custom Discord emojis inline while keeping ordinary images as blocks', async () => {
    const image = `data:image/png;base64,${(
      await sharp({
        create: {
          width: 12,
          height: 12,
          channels: 4,
          background: '#ffb347',
        },
      })
        .png()
        .toBuffer()
    ).toString('base64')}`;

    const [png] = await renderMessageCards({
      sourcePlatform: 'discord',
      targetLanguage: 'zh',
      sourceName: 'general',
      senderName: 'Alice',
      sentAt: '2026-08-06 12:00',
      primaryText: '前 <:phigros:1094607105127891054> 后',
      originalText: '原文 <:phigros:1094607105127891054>',
      inlineEmojis: [
        {
          token: '<:phigros:1094607105127891054>',
          dataUri: image,
        },
      ],
      reply: {
        senderName: 'Bob',
        textPreview: '引用 <:reply:2>',
        inlineEmojis: [{ token: '<:reply:2>', dataUri: image }],
      },
      images: [image],
    });

    const metadata = await sharp(png).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(1_000);
    expect(png.byteLength).toBeGreaterThan(1_000);
  });

  it('keeps a small image on a single card', async () => {
    const image = await rowEncodedPng(200, 200);
    const cards = await renderMessageCards({
      sourcePlatform: 'qq',
      sourceName: '群',
      senderName: 'Alice',
      sentAt: '2026-08-06 12:00',
      primaryText: '一张小图',
      images: [image],
    });
    expect(cards.length).toBe(1);
  });

  it('slices a tall image so the next message head stitches to the tail', async () => {
    // 888 wide keeps scale 1, so band boundaries land on exact source rows.
    const image = await rowEncodedPng(888, 3_000);
    const cards = await renderMessageCards({
      sourcePlatform: 'qq',
      sourceName: '群',
      senderName: 'Alice',
      sentAt: '2026-08-06 12:00',
      primaryText: '长图切片',
      images: [image],
    });
    // 3000px tall -> band of 2048 on the main card + one 952px tile card.
    expect(cards.length).toBe(2);

    const mainMetadata = await sharp(cards[0]).metadata();
    expect(mainMetadata.height).toBeLessThanOrEqual(8_192);
    // Layout: cursorY = 170, one primary line -> image block starts at y = 250.
    const imageTop = 250;
    const imageBottom = imageTop + 2_048 - 1;
    // Row encoding: source row 0 = [0,0,0], 2047 = [255,7,0], 2048 = [0,8,0].
    expect(await readRgbPixel(cards[0], 256, imageTop)).toEqual([0, 0, 0]);
    expect(await readRgbPixel(cards[0], 256, imageBottom)).toEqual([255, 7, 0]);
    // The tile card's top row is the very next source row: seamless seam.
    expect(await readRgbPixel(cards[1], 256, 0)).toEqual([0, 8, 0]);
  });

  it('shows a red 不可回复 badge when the card is non-replyable', async () => {
    const zh = buildMessageCardSvg({
      sourcePlatform: 'qq',
      targetLanguage: 'zh',
      sourceName: '通知频道',
      senderName: 'Bot',
      sentAt: '2026-08-08 12:00',
      primaryText: '公告内容',
      images: [],
      nonReplyable: true,
    });
    expect(zh).toContain('不可回复');

    const en = buildMessageCardSvg({
      sourcePlatform: 'discord',
      targetLanguage: 'en',
      sourceName: 'notifications',
      senderName: 'Bot',
      sentAt: '2026-08-08 12:00',
      primaryText: 'announcement',
      images: [],
      nonReplyable: true,
    });
    expect(en).toContain('NO REPLY');

    const [png] = await renderMessageCards({
      sourcePlatform: 'qq',
      targetLanguage: 'zh',
      sourceName: '通知频道',
      senderName: 'Bot',
      sentAt: '2026-08-08 12:00',
      primaryText: '公告内容',
      images: [],
      nonReplyable: true,
    });
    // The badge fill, border, and text are red (#ff5c5c); the rest of a plain
    // text card is near-grayscale, so a strongly red pixel proves the badge.
    expect(await hasRedPixel(png)).toBe(true);
  });

  it('does not split English words across lines', () => {
    const svg = buildMessageCardSvg({
      sourcePlatform: 'qq',
      targetLanguage: 'en',
      sourceName: 'group',
      senderName: 'Alice',
      sentAt: '2026-08-06 12:00',
      // 40 'a's fill the line so "wonderful" lands exactly at a wrap boundary.
      primaryText: `${'a'.repeat(40)} wonderful tail`,
      images: [],
    });
    const lines = Array.from(svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/gu)).map(
      (match) => match[1]!,
    );
    const lineWithWord = lines.findIndex((line) => line.includes('wonderful'));
    expect(lineWithWord).toBeGreaterThan(-1);
    expect(lines[lineWithWord]).toContain('wonderful');
  });

  it('keeps every sliced card within the height cap', async () => {
    // 400x10000 upscales to 888 wide, i.e. 22200px tall -> 11 bands.
    const image = await rowEncodedPng(400, 10_000);
    const cards = await renderMessageCards({
      sourcePlatform: 'qq',
      sourceName: '群',
      senderName: 'Alice',
      sentAt: '2026-08-06 12:00',
      primaryText: '超长图',
      images: [image],
    });
    // Main card + 10 tile cards; every card stays within the platform cap.
    expect(cards.length).toBe(11);
    for (const card of cards) {
      const metadata = await sharp(card).metadata();
      expect(metadata.height).toBeLessThanOrEqual(8_192);
    }
  });

  it('scales every image to the fixed content width', async () => {
    const render = async (size: number): Promise<number> => {
      const [card] = await renderMessageCards({
        sourcePlatform: 'qq',
        sourceName: '群',
        senderName: 'Alice',
        sentAt: '2026-08-06 12:00',
        primaryText: '固定宽度',
        images: [await rowEncodedPng(size, size)],
      });
      const metadata = await sharp(card).metadata();
      return metadata.height!;
    };
    // 200x200 and 400x400 both scale up to the 888px content width, so the two
    // cards are identical: one primary line (chrome 352) + an 888px image.
    expect(await render(200)).toBe(await render(400));
    expect(await render(200)).toBe(352 + 888);
  });
});
