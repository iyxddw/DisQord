import { createCanvas, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { messageCardRenderSpecSchema, type MessageCardRenderSpec } from '@disqord/shared';
import { z } from 'zod';

const dataImageSchema = z.string().regex(/^data:image\/(?:png|jpeg|webp|gif);base64,/u);

export const messageCardInputSchema = z.object({
  sourcePlatform: z.enum(['qq', 'discord']),
  targetLanguage: z.enum(['zh', 'en']).optional(),
  sourceName: z.string().trim().min(1).max(256),
  senderName: z.string().trim().min(1).max(256),
  senderAvatar: dataImageSchema.optional(),
  sentAt: z.string().min(1).max(128),
  primaryText: z.string().max(30_000),
  originalText: z.string().max(30_000).optional(),
  images: z.array(dataImageSchema).max(10).default([]),
  inlineEmojis: z
    .array(
      z.object({
        token: z.string().trim().min(1).max(128),
        dataUri: dataImageSchema,
      }),
    )
    .max(32)
    .optional(),
  reply: z
    .object({
      senderName: z.string().trim().min(1).max(256),
      textPreview: z.string().max(1_000).optional(),
      inlineEmojis: z
        .array(
          z.object({
            token: z.string().trim().min(1).max(128),
            dataUri: dataImageSchema,
          }),
        )
        .max(32)
        .optional(),
      imagePreview: dataImageSchema.optional(),
    })
    .optional(),
  unsupportedType: z.string().trim().min(1).max(128).optional(),
  traceLabel: z.string().trim().min(1).max(64).optional(),
});

export type MessageCardInput = z.infer<typeof messageCardInputSchema>;

const width = 1_000;
const horizontalPadding = 56;
const contentWidth = width - horizontalPadding * 2;
const lineHeight = 48;
// Keep a real CJK/Latin font first.  Skia can otherwise select Noto Color
// Emoji for the whole run on Linux, which turns Chinese into tofu boxes and
// gives ASCII text emoji-sized advances.  Emoji remains in the fallback tail
// so emoji glyphs still render when the target machine has the font installed.
const fontFamily =
  '"Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "PingFang SC", "WenQuanYi Micro Hei", "Noto Sans", "Segoe UI", "Noto Color Emoji", "Segoe UI Emoji", sans-serif';

export async function renderMessageCards(
  candidate: MessageCardInput | MessageCardRenderSpec,
): Promise<Buffer[]> {
  const input = await normalizeCanvasInput(candidate);
  const inlineEmojiReplacements = createInlineEmojiReplacements([
    ...(input.inlineEmojis ?? []),
    ...(input.reply?.inlineEmojis ?? []),
  ]);
  const inlineEmojiImages = await loadInlineEmojiImages(inlineEmojiReplacements);
  const displayText = input.unsupportedType
    ? unsupportedMessage(input.unsupportedType, input.targetLanguage ?? 'en')
    : replaceInlineEmojiTokens(input.primaryText, inlineEmojiReplacements);
  const originalText = input.originalText
    ? replaceInlineEmojiTokens(input.originalText, inlineEmojiReplacements)
    : undefined;
  const reply = input.reply
    ? {
        ...input.reply,
        ...(input.reply.textPreview
          ? {
              textPreview: replaceInlineEmojiTokens(
                input.reply.textPreview,
                inlineEmojiReplacements,
              ),
            }
          : {}),
      }
    : undefined;
  const primaryPages = paginateText(displayText, 34);
  const originalPages = originalText ? paginateText(originalText, 28) : [[]];
  const pageCount = Math.max(primaryPages.length, originalPages.length, 1);
  const cards: Buffer[] = [];

  for (let page = 0; page < pageCount; page += 1) {
    cards.push(
      await renderMessageCardCanvas({
        ...input,
        primaryText: (primaryPages[page] ?? []).join('\n'),
        ...(originalText ? { originalText: (originalPages[page] ?? []).join('\n') } : {}),
        images: page === 0 ? input.images : [],
        ...(reply ? { reply } : {}),
        inlineEmojiReplacements,
        inlineEmojiImages,
        ...(pageCount > 1
          ? { traceLabel: `${input.traceLabel ?? ''} ${page + 1}/${pageCount}`.trim() }
          : {}),
      }),
    );
  }
  return cards;
}

type InlineEmojiReplacement = {
  readonly token: string;
  readonly placeholder: string;
  readonly dataUri: string;
};

type CanvasCardInput = MessageCardInput & {
  readonly inlineEmojiReplacements?: readonly InlineEmojiReplacement[];
  readonly inlineEmojiImages?: ReadonlyMap<string, Image>;
};

async function normalizeCanvasInput(
  candidate: MessageCardInput | MessageCardRenderSpec,
): Promise<CanvasCardInput> {
  const legacy = messageCardInputSchema.safeParse(candidate);
  if (legacy.success) return legacy.data;

  const spec = messageCardRenderSpecSchema.parse(candidate);
  const images = spec.images.map((media) => media.dataUri);
  const replyImage = spec.reply?.imagePreview?.dataUri;
  return {
    sourcePlatform: spec.sourcePlatform,
    targetLanguage: spec.targetLanguage,
    sourceName: spec.sourceName,
    senderName: spec.senderName,
    ...(spec.senderAvatar ? { senderAvatar: spec.senderAvatar } : {}),
    sentAt: spec.sentAt,
    primaryText: spec.primaryText,
    ...(spec.originalText ? { originalText: spec.originalText } : {}),
    images,
    ...(spec.inlineEmojis?.length
      ? {
          inlineEmojis: spec.inlineEmojis.map((emoji) => ({
            token: emoji.token,
            dataUri: emoji.dataUri,
          })),
        }
      : {}),
    ...(spec.reply
      ? {
          reply: {
            senderName: spec.reply.senderName,
            ...(spec.reply.textPreview ? { textPreview: spec.reply.textPreview } : {}),
            ...(spec.reply.inlineEmojis?.length
              ? {
                  inlineEmojis: spec.reply.inlineEmojis.map((emoji) => ({
                    token: emoji.token,
                    dataUri: emoji.dataUri,
                  })),
                }
              : {}),
            ...(replyImage ? { imagePreview: replyImage } : {}),
          },
        }
      : {}),
    ...(spec.unsupportedType ? { unsupportedType: spec.unsupportedType } : {}),
    ...(spec.traceLabel ? { traceLabel: spec.traceLabel } : {}),
  };
}

async function renderMessageCardCanvas(input: CanvasCardInput): Promise<Buffer> {
  const language = input.targetLanguage ?? 'en';
  const inlineEmojiImages =
    input.inlineEmojiImages ?? (await loadInlineEmojiImages(input.inlineEmojiReplacements ?? []));
  const inlineEmojiFallbacks = new Map(
    (input.inlineEmojiReplacements ?? []).map((emoji) => [emoji.placeholder, emoji.token]),
  );
  const primaryLines = wrapText(
    input.unsupportedType ? unsupportedMessage(input.unsupportedType, language) : input.primaryText,
    42,
  );
  const replyLines = input.reply
    ? wrapText(
        input.reply.textPreview ||
          (input.reply.imagePreview
            ? ''
            : language === 'zh'
              ? '无可用预览'
              : 'Preview unavailable'),
        52,
      ).slice(0, 4)
    : [];
  const replyImageHeight = input.reply?.imagePreview ? 180 : 0;
  const originalLines = input.originalText ? wrapText(input.originalText, 52) : [];
  const replyHeight = input.reply
    ? 64 + replyLines.length * 32 + replyImageHeight + (replyImageHeight ? 16 : 0)
    : 0;
  const primaryHeight = Math.max(1, primaryLines.length) * lineHeight;
  const imageHeight = input.images.length * 420;
  const originalHeight = input.originalText ? 88 + Math.max(1, originalLines.length) * 36 : 0;
  const height = Math.min(
    8_192,
    208 + replyHeight + primaryHeight + imageHeight + originalHeight + 96,
  );
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';

  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#151925');
  background.addColorStop(0.55, '#11131a');
  background.addColorStop(1, '#1c1730');
  ctx.fillStyle = background;
  roundedRect(ctx, 0, 0, width, height, 28);
  ctx.fill();

  const avatar = input.senderAvatar ? await loadDataImage(input.senderAvatar) : undefined;
  if (avatar) {
    ctx.save();
    circleClip(ctx, horizontalPadding + 38, 86, 38);
    drawCover(ctx, avatar, horizontalPadding, 48, 76, 76);
    ctx.restore();
  } else {
    ctx.fillStyle = '#5262a8';
    ctx.beginPath();
    ctx.arc(horizontalPadding + 38, 86, 38, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `700 32px ${fontFamily}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(input.senderName.slice(0, 1).toUpperCase(), horizontalPadding + 38, 98);
    ctx.textAlign = 'start';
  }

  ctx.font = `700 30px ${fontFamily}`;
  ctx.fillStyle = '#f7f8ff';
  ctx.fillText(input.senderName, horizontalPadding + 98, 78);
  ctx.font = `20px ${fontFamily}`;
  ctx.fillStyle = '#aeb6cc';
  ctx.fillText(`${input.sourceName} · ${input.sentAt}`, horizontalPadding + 98, 112);
  ctx.font = `700 19px ${fontFamily}`;
  ctx.fillStyle = '#91a7ff';
  ctx.textAlign = 'right';
  ctx.fillText(input.sourcePlatform.toUpperCase(), width - horizontalPadding, 76);
  ctx.textAlign = 'start';

  let cursorY = 170;
  if (input.reply) {
    const top = cursorY;
    cursorY += replyHeight + 24;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    roundedRect(ctx, horizontalPadding, top, contentWidth, replyHeight, 18);
    ctx.fill();
    ctx.fillStyle = '#91a7ff';
    roundedRect(ctx, horizontalPadding, top, 5, replyHeight, 3);
    ctx.fill();
    ctx.font = `700 24px ${fontFamily}`;
    ctx.fillStyle = '#aab8ff';
    ctx.fillText(input.reply.senderName, horizontalPadding + 24, top + 34);
    drawLines(
      ctx,
      replyLines,
      horizontalPadding + 24,
      top + 70,
      30,
      `25px ${fontFamily}`,
      '#c8cede',
      inlineEmojiImages,
      inlineEmojiFallbacks,
    );
    if (input.reply.imagePreview) {
      const image = await loadDataImage(input.reply.imagePreview);
      if (image) {
        drawContain(
          ctx,
          image,
          horizontalPadding + 24,
          top + 54 + replyLines.length * 32,
          contentWidth - 48,
          replyImageHeight,
        );
      }
    }
  }

  const primaryTop = cursorY;
  cursorY += primaryHeight + 32;
  drawLines(
    ctx,
    primaryLines.length ? primaryLines : [' '],
    horizontalPadding,
    primaryTop + 38,
    lineHeight,
    `500 34px ${fontFamily}`,
    '#f7f8ff',
    inlineEmojiImages,
    inlineEmojiFallbacks,
  );

  for (const [index, imageData] of input.images.entries()) {
    const y = cursorY + index * 420;
    ctx.fillStyle = '#0b0d13';
    roundedRect(ctx, horizontalPadding, y, contentWidth, 396, 22);
    ctx.fill();
    const image = await loadDataImage(imageData);
    if (image) {
      ctx.save();
      roundedRect(ctx, horizontalPadding, y, contentWidth, 396, 22);
      ctx.clip();
      drawContain(ctx, image, horizontalPadding, y, contentWidth, 396);
      ctx.restore();
    }
  }
  cursorY += imageHeight;

  if (input.originalText) {
    const top = cursorY + 8;
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    roundedRect(ctx, horizontalPadding, top, contentWidth, originalHeight, 22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = `700 18px ${fontFamily}`;
    ctx.fillStyle = '#aeb6cc';
    ctx.fillText(language === 'zh' ? '原文' : 'ORIGINAL', horizontalPadding + 28, top + 38);
    drawLines(
      ctx,
      originalLines,
      horizontalPadding + 28,
      top + 80,
      36,
      `26px ${fontFamily}`,
      '#e2e5ef',
      inlineEmojiImages,
      inlineEmojiFallbacks,
    );
  }

  ctx.font = `17px ${fontFamily}`;
  ctx.fillStyle = '#737c92';
  ctx.fillText(`DisQord · ${input.traceLabel ?? ''}`, horizontalPadding, height - 38);
  return canvas.toBuffer('image/png');
}

async function loadDataImage(dataUri: string): Promise<Image | undefined> {
  try {
    const match = /^data:image\/[\w.+-]+;base64,(.+)$/u.exec(dataUri);
    return match ? await loadImage(Buffer.from(match[1]!, 'base64')) : undefined;
  } catch {
    return undefined;
  }
}

function createInlineEmojiReplacements(
  inlineEmojis: MessageCardInput['inlineEmojis'],
): InlineEmojiReplacement[] {
  const seen = new Set<string>();
  return (inlineEmojis ?? []).flatMap((emoji, index) => {
    if (seen.has(emoji.token)) return [];
    seen.add(emoji.token);
    return [
      {
        token: emoji.token,
        placeholder: String.fromCodePoint(0xe000 + index),
        dataUri: emoji.dataUri,
      },
    ];
  });
}

function replaceInlineEmojiTokens(
  text: string,
  replacements: readonly InlineEmojiReplacement[],
): string {
  let replaced = text;
  for (const replacement of replacements) {
    replaced = replaced.replaceAll(replacement.token, replacement.placeholder);
  }
  return replaced;
}

async function loadInlineEmojiImages(
  replacements: readonly InlineEmojiReplacement[],
): Promise<ReadonlyMap<string, Image>> {
  const loaded = await Promise.all(
    replacements.map(async (replacement) => {
      const image = await loadDataImage(replacement.dataUri);
      return image ? ([replacement.placeholder, image] as const) : undefined;
    }),
  );
  return new Map(loaded.filter((entry): entry is readonly [string, Image] => Boolean(entry)));
}

function roundedRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

function circleClip(ctx: SKRSContext2D, x: number, y: number, radius: number): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
}

function drawCover(
  ctx: SKRSContext2D,
  image: Image,
  x: number,
  y: number,
  widthValue: number,
  heightValue: number,
): void {
  const scale = Math.max(widthValue / image.width, heightValue / image.height);
  const widthScaled = image.width * scale;
  const heightScaled = image.height * scale;
  ctx.drawImage(
    image,
    x + (widthValue - widthScaled) / 2,
    y + (heightValue - heightScaled) / 2,
    widthScaled,
    heightScaled,
  );
}

function drawContain(
  ctx: SKRSContext2D,
  image: Image,
  x: number,
  y: number,
  widthValue: number,
  heightValue: number,
): void {
  const scale = Math.min(widthValue / image.width, heightValue / image.height);
  const widthScaled = image.width * scale;
  const heightScaled = image.height * scale;
  ctx.drawImage(
    image,
    x + (widthValue - widthScaled) / 2,
    y + (heightValue - heightScaled) / 2,
    widthScaled,
    heightScaled,
  );
}

function drawLines(
  ctx: SKRSContext2D,
  lines: readonly string[],
  x: number,
  y: number,
  spacing: number,
  font: string,
  color: string,
  inlineEmojiImages?: ReadonlyMap<string, Image>,
  inlineEmojiFallbacks?: ReadonlyMap<string, string>,
): void {
  ctx.font = font;
  ctx.fillStyle = color;
  for (const [index, line] of lines.entries()) {
    drawInlineLine(
      ctx,
      line || ' ',
      x,
      y + index * spacing,
      spacing,
      inlineEmojiImages,
      inlineEmojiFallbacks,
    );
  }
}

function drawInlineLine(
  ctx: SKRSContext2D,
  line: string,
  x: number,
  baseline: number,
  lineSpacing: number,
  inlineEmojiImages?: ReadonlyMap<string, Image>,
  inlineEmojiFallbacks?: ReadonlyMap<string, string>,
): void {
  if (!inlineEmojiImages?.size) {
    ctx.fillText(line, x, baseline);
    return;
  }
  const emojiSize = Math.max(24, Math.round(lineSpacing * 0.78));
  let cursor = x;
  let textBuffer = '';
  const flushText = (): void => {
    if (!textBuffer) return;
    ctx.fillText(textBuffer, cursor, baseline);
    cursor += ctx.measureText(textBuffer).width;
    textBuffer = '';
  };

  for (const character of line) {
    const image = inlineEmojiImages.get(character);
    if (!image) {
      textBuffer += inlineEmojiFallbacks?.get(character) ?? character;
      continue;
    }
    flushText();
    ctx.drawImage(image, cursor, baseline - emojiSize + 4, emojiSize, emojiSize);
    cursor += emojiSize + 4;
  }
  flushText();
}

/**
 * @deprecated Kept for old integrations and snapshot tests. Production
 * deliveries use renderMessageCards(), which is Canvas/Skia based and runs on
 * the target platform node.
 */
export function buildMessageCardSvg(candidate: MessageCardInput): string {
  const input = messageCardInputSchema.parse(candidate);
  const language = input.targetLanguage ?? 'en';
  const primaryLines = wrapText(
    input.unsupportedType ? unsupportedMessage(input.unsupportedType, language) : input.primaryText,
    42,
  );
  const replyLines = input.reply
    ? wrapText(
        input.reply.textPreview ||
          (input.reply.imagePreview
            ? ''
            : language === 'zh'
              ? '无可用预览'
              : 'Preview unavailable'),
        52,
      ).slice(0, 4)
    : [];
  const replyImageHeight = input.reply?.imagePreview ? 180 : 0;
  const originalLines = input.originalText ? wrapText(input.originalText, 52) : [];
  const replyHeight = input.reply
    ? 64 + replyLines.length * 32 + replyImageHeight + (replyImageHeight ? 16 : 0)
    : 0;
  const primaryHeight = Math.max(1, primaryLines.length) * lineHeight;
  const imageHeight = input.images.length * 420;
  const originalHeight = input.originalText ? 88 + Math.max(1, originalLines.length) * 36 : 0;
  const height = Math.min(
    8_192,
    208 + replyHeight + primaryHeight + imageHeight + originalHeight + 96,
  );
  let cursorY = 170;

  const replySvg = input.reply
    ? (() => {
        const top = cursorY;
        cursorY += replyHeight + 24;
        return `
          <rect x="${horizontalPadding}" y="${top}" width="${contentWidth}" height="${replyHeight}"
            rx="18" fill="#ffffff" fill-opacity="0.08"/>
          <rect x="${horizontalPadding}" y="${top}" width="5" height="${replyHeight}"
            rx="3" fill="#91a7ff"/>
          <text x="${horizontalPadding + 24}" y="${top + 34}" class="reply-name">${escapeXml(input.reply!.senderName)}</text>
          ${svgTextLines(replyLines, horizontalPadding + 24, top + 70, 30, 'reply-text')}
          ${
            input.reply!.imagePreview
              ? `<image href="${input.reply!.imagePreview}" x="${horizontalPadding + 24}"
                  y="${top + 54 + replyLines.length * 32}" width="${contentWidth - 48}"
                  height="${replyImageHeight}" preserveAspectRatio="xMidYMid meet"/>`
              : ''
          }
        `;
      })()
    : '';

  const primaryTop = cursorY;
  cursorY += primaryHeight + 32;
  const primarySvg = svgTextLines(
    primaryLines.length ? primaryLines : [' '],
    horizontalPadding,
    primaryTop + 38,
    lineHeight,
    'primary-text',
  );

  const imagesSvg = input.images
    .map((image, index) => {
      const y = cursorY + index * 420;
      return `
        <rect x="${horizontalPadding}" y="${y}" width="${contentWidth}" height="396" rx="22"
          fill="#0b0d13"/>
        <image href="${image}" x="${horizontalPadding}" y="${y}" width="${contentWidth}" height="396"
          preserveAspectRatio="xMidYMid meet" clip-path="url(#imageClip${index})"/>
      `;
    })
    .join('');
  cursorY += imageHeight;

  const originalSvg = input.originalText
    ? (() => {
        const top = cursorY + 8;
        return `
          <rect x="${horizontalPadding}" y="${top}" width="${contentWidth}" height="${originalHeight}"
            rx="22" fill="#ffffff" fill-opacity="0.10" stroke="#ffffff" stroke-opacity="0.12"/>
          <text x="${horizontalPadding + 28}" y="${top + 38}" class="original-label">${language === 'zh' ? '原文' : 'ORIGINAL'}</text>
          ${svgTextLines(originalLines, horizontalPadding + 28, top + 80, 36, 'original-text')}
        `;
      })()
    : '';

  const avatar = input.senderAvatar
    ? `<image href="${input.senderAvatar}" x="${horizontalPadding}" y="48" width="76" height="76"
        preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
    : `<circle cx="${horizontalPadding + 38}" cy="86" r="38" fill="#5262a8"/>
       <text x="${horizontalPadding + 38}" y="98" text-anchor="middle" class="avatar-letter">${escapeXml(input.senderName.slice(0, 1).toUpperCase())}</text>`;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#151925"/>
          <stop offset="0.55" stop-color="#11131a"/>
          <stop offset="1" stop-color="#1c1730"/>
        </linearGradient>
        <clipPath id="avatarClip"><circle cx="${horizontalPadding + 38}" cy="86" r="38"/></clipPath>
        ${input.images
          .map(
            (_image, index) =>
              `<clipPath id="imageClip${index}"><rect x="${horizontalPadding}" y="${primaryTop + primaryHeight + 32 + index * 420}" width="${contentWidth}" height="396" rx="22"/></clipPath>`,
          )
          .join('')}
        <style>
          text { font-family: ${fontFamily}; }
          .sender { fill: #f7f8ff; font-size: 30px; font-weight: 700; }
          .meta { fill: #aeb6cc; font-size: 20px; }
          .platform { fill: #91a7ff; font-size: 19px; font-weight: 700; letter-spacing: 1px; }
          .avatar-letter { fill: #ffffff; font-size: 32px; font-weight: 700; }
          .reply-name { fill: #aab8ff; font-size: 24px; font-weight: 700; }
          .reply-text { fill: #c8cede; font-size: 25px; }
          .primary-text { fill: #f7f8ff; font-size: 34px; font-weight: 500; }
          .original-label { fill: #aeb6cc; font-size: 18px; font-weight: 700; letter-spacing: 1.5px; }
          .original-text { fill: #e2e5ef; font-size: 26px; }
          .footer { fill: #737c92; font-size: 17px; }
        </style>
      </defs>
      <rect width="${width}" height="${height}" rx="28" fill="url(#background)"/>
      ${avatar}
      <text x="${horizontalPadding + 98}" y="78" class="sender">${escapeXml(input.senderName)}</text>
      <text x="${horizontalPadding + 98}" y="112" class="meta">${escapeXml(input.sourceName)} · ${escapeXml(input.sentAt)}</text>
      <text x="${width - horizontalPadding}" y="76" text-anchor="end" class="platform">${input.sourcePlatform.toUpperCase()}</text>
      ${replySvg}
      ${primarySvg}
      ${imagesSvg}
      ${originalSvg}
      <text x="${horizontalPadding}" y="${height - 38}" class="footer">DisQord · ${escapeXml(input.traceLabel ?? '')}</text>
    </svg>
  `;
}

function wrapText(text: string, maxColumns: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/gu, '\n').split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let current = '';
    let columns = 0;
    for (const character of paragraph) {
      const width = (character.codePointAt(0) ?? 0) <= 0xff ? 1 : 2;
      if (columns + width > maxColumns && current) {
        lines.push(current);
        current = '';
        columns = 0;
      }
      current += character;
      columns += width;
    }
    if (current) lines.push(current);
  }
  return lines;
}

function paginateText(text: string, maxLines: number): string[][] {
  const lines = wrapText(text, 42);
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += maxLines) {
    pages.push(lines.slice(index, index + maxLines));
  }
  return pages.length ? pages : [[]];
}

function svgTextLines(
  lines: readonly string[],
  x: number,
  y: number,
  lineSpacing: number,
  className: string,
): string {
  return `<text x="${x}" y="${y}" class="${className}">${lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : lineSpacing}">${escapeXml(line || ' ')}</tspan>`,
    )
    .join('')}</text>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function unsupportedMessage(type: string, language: 'zh' | 'en'): string {
  return language === 'zh' ? `不支持的消息\n类型：${type}` : `Unsupported message\nType: ${type}`;
}
