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
  /** Forwarded out of a fetch-only session; show a red 不可回复 badge. */
  nonReplyable: z.boolean().optional(),
});

export type MessageCardInput = z.infer<typeof messageCardInputSchema>;

const width = 1_000;
const horizontalPadding = 56;
const contentWidth = width - horizontalPadding * 2;
const lineHeight = 48;
// A single card may not exceed this height (platform canvas cap).
const MAX_CARD_HEIGHT = 8_192;
// A message image taller than this is sliced into vertical bands, one per
// card, so tall images span multiple messages instead of being cut off.
const IMAGE_TILE_HEIGHT = 2_048;
// Vertical space between two different images stacked on one card.  Continuation
// bands of the same image get no gap so consecutive messages stitch seamlessly.
const imageGap = 24;
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
    const pageInput: CanvasCardInput = {
      ...input,
      primaryText: (primaryPages[page] ?? []).join('\n'),
      ...(originalText ? { originalText: (originalPages[page] ?? []).join('\n') } : {}),
      ...(reply ? { reply } : {}),
      inlineEmojiReplacements,
      inlineEmojiImages,
      ...(pageCount > 1
        ? { traceLabel: `${input.traceLabel ?? ''} ${page + 1}/${pageCount}`.trim() }
        : {}),
    };
    if (page > 0) {
      // Continuation text pages carry no images.
      cards.push(await renderMessageCardCanvas(pageInput, []));
      continue;
    }
    // Page 0 is the chrome card plus a pure-image tile card per leftover band.
    const sizedImages = await loadSizedImages(input.images);
    const bands = buildImageBands(sizedImages, IMAGE_TILE_HEIGHT);
    const { chromeHeight } = computeLayout(pageInput);
    const { card1Bands, tileBands } = planImageBands(bands, chromeHeight);
    cards.push(await renderMessageCardCanvas(pageInput, card1Bands));
    for (const band of tileBands) {
      cards.push(renderImageTileCard(band));
    }
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

type SizedImage = {
  readonly image: Image;
  readonly w: number;
  readonly h: number;
};

/**
 * A horizontal slice of a sized image, drawn from the source rect
 * `[0, srcY, image.width, srcH]` into `[horizontalPadding, y, w, h]`.
 * `srcW` is always `image.width`.  `first`/`last` mark the image's top and
 * bottom bands so the card knows which corners to round (seams stay square).
 */
type ImageBand = {
  readonly image: Image;
  readonly srcY: number;
  readonly srcH: number;
  readonly w: number;
  readonly h: number;
  readonly first: boolean;
  readonly last: boolean;
};

async function normalizeCanvasInput(
  candidate: MessageCardInput | MessageCardRenderSpec,
): Promise<CanvasCardInput> {
  const legacy = messageCardInputSchema.safeParse(candidate);
  if (legacy.success) return legacy.data;

  const spec = messageCardRenderSpecSchema.parse(candidate);
  const images = spec.images.map((media) => media.dataUri);
  const replyImage = spec.reply?.imagePreview?.dataUri;
  const inlineEmojis = spec.inlineEmojis?.flatMap((emoji) =>
    emoji.dataUri ? [{ token: emoji.token, dataUri: emoji.dataUri }] : [],
  );
  const replyInlineEmojis = spec.reply?.inlineEmojis?.flatMap((emoji) =>
    emoji.dataUri ? [{ token: emoji.token, dataUri: emoji.dataUri }] : [],
  );
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
    ...(inlineEmojis?.length ? { inlineEmojis } : {}),
    ...(spec.reply
      ? {
          reply: {
            senderName: spec.reply.senderName,
            ...(spec.reply.textPreview ? { textPreview: spec.reply.textPreview } : {}),
            ...(replyInlineEmojis?.length ? { inlineEmojis: replyInlineEmojis } : {}),
            ...(replyImage ? { imagePreview: replyImage } : {}),
          },
        }
      : {}),
    ...(spec.unsupportedType ? { unsupportedType: spec.unsupportedType } : {}),
    ...(spec.traceLabel ? { traceLabel: spec.traceLabel } : {}),
    ...(spec.nonReplyable ? { nonReplyable: true } : {}),
  };
}

async function renderMessageCardCanvas(
  input: CanvasCardInput,
  bands: readonly ImageBand[],
): Promise<Buffer> {
  const language = input.targetLanguage ?? 'en';
  const inlineEmojiImages =
    input.inlineEmojiImages ?? (await loadInlineEmojiImages(input.inlineEmojiReplacements ?? []));
  const inlineEmojiFallbacks = new Map(
    (input.inlineEmojiReplacements ?? []).map((emoji) => [emoji.placeholder, emoji.token]),
  );
  const {
    primaryLines,
    replyLines,
    replyImageHeight,
    originalLines,
    replyHeight,
    primaryHeight,
    originalHeight,
    chromeHeight,
  } = computeLayout(input);
  let imageHeight = 0;
  for (const [index, band] of bands.entries()) {
    imageHeight += band.h;
    if (band.first && index > 0) imageHeight += imageGap;
  }
  const height = Math.min(MAX_CARD_HEIGHT, chromeHeight + imageHeight);
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

  if (input.nonReplyable) {
    const badgeText = language === 'zh' ? '不可回复' : 'NO REPLY';
    ctx.font = `700 20px ${fontFamily}`;
    const textWidth = ctx.measureText(badgeText).width;
    const padX = 16;
    const padY = 10;
    const badgeWidth = textWidth + padX * 2;
    const badgeHeight = 24 + padY * 2;
    const badgeX = width - horizontalPadding - badgeWidth;
    const badgeY = 126;
    ctx.fillStyle = 'rgba(255, 77, 79, 0.16)';
    roundedRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, badgeHeight / 2);
    ctx.fill();
    ctx.strokeStyle = '#ff5c5c';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ff5c5c';
    ctx.textAlign = 'center';
    ctx.fillText(badgeText, badgeX + badgeWidth / 2, badgeY + padY + 17);
    ctx.textAlign = 'start';
  }

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

  let imageY = cursorY;
  for (const [index, band] of bands.entries()) {
    if (band.first && index > 0) imageY += imageGap;
    const radius = Math.min(22, band.h / 2);
    const corners: [number, number, number, number] = [
      band.first ? radius : 0,
      band.first ? radius : 0,
      band.last ? radius : 0,
      band.last ? radius : 0,
    ];
    ctx.fillStyle = '#0b0d13';
    roundedRectRadii(ctx, horizontalPadding, imageY, band.w, band.h, corners);
    ctx.fill();
    ctx.save();
    roundedRectRadii(ctx, horizontalPadding, imageY, band.w, band.h, corners);
    ctx.clip();
    ctx.drawImage(
      band.image,
      0,
      band.srcY,
      band.image.width,
      band.srcH,
      horizontalPadding,
      imageY,
      band.w,
      band.h,
    );
    ctx.restore();
    imageY += band.h;
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

async function loadSizedImages(dataUris: readonly string[]): Promise<readonly SizedImage[]> {
  const loaded = await Promise.all(
    dataUris.map(async (dataUri): Promise<SizedImage | undefined> => {
      const image = await loadDataImage(dataUri);
      if (!image) return undefined;
      // Every image spans the fixed content width, so narrow images upscale and
      // all blocks render centered with even margins on both sides.
      const scale = contentWidth / image.width;
      return {
        image,
        w: Math.max(1, Math.round(image.width * scale)),
        h: Math.max(1, Math.round(image.height * scale)),
      };
    }),
  );
  return loaded.filter((item): item is SizedImage => Boolean(item));
}

/**
 * Splits sized images into vertical bands.  Images no taller than `tileHeight`
 * yield a single full band; taller ones are cut into ~`tileHeight`-tall bands.
 * Band boundaries are integer source rows: `srcY` accumulates rounding and
 * `srcH` is the distance to the next boundary, so the source pixels are tiled
 * with no gaps and no overlap, and the last band reaches `image.height`.
 * Each band is displayed with the same scale (`w / image.width`), which makes
 * consecutive messages stitch seamlessly.
 */
function buildImageBands(
  sizedImages: readonly SizedImage[],
  tileHeight: number,
): readonly ImageBand[] {
  const bands: ImageBand[] = [];
  for (const item of sizedImages) {
    if (item.h <= tileHeight) {
      bands.push({
        image: item.image,
        srcY: 0,
        srcH: item.image.height,
        w: item.w,
        h: item.h,
        first: true,
        last: true,
      });
      continue;
    }
    const srcScale = item.image.width / item.w;
    const count = Math.ceil(item.h / tileHeight);
    const boundaries = Array.from({ length: count + 1 }, (_, index) =>
      Math.min(item.image.height, Math.round(index * tileHeight * srcScale)),
    );
    for (let index = 0; index < count; index += 1) {
      const srcY = boundaries[index]!;
      const srcH = boundaries[index + 1]! - srcY;
      bands.push({
        image: item.image,
        srcY,
        srcH,
        w: item.w,
        h: Math.max(1, Math.round((srcH * item.w) / item.image.width)),
        first: index === 0,
        last: index === count - 1,
      });
    }
  }
  return bands;
}

type CardLayout = {
  readonly primaryLines: readonly string[];
  readonly replyLines: readonly string[];
  readonly replyImageHeight: number;
  readonly originalLines: readonly string[];
  readonly replyHeight: number;
  readonly primaryHeight: number;
  readonly originalHeight: number;
  /** Non-image card content: header + reply + primary + original + footer. */
  readonly chromeHeight: number;
};

function computeLayout(input: CanvasCardInput): CardLayout {
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
  const originalHeight = input.originalText ? 88 + Math.max(1, originalLines.length) * 36 : 0;
  return {
    primaryLines,
    replyLines,
    replyImageHeight,
    originalLines,
    replyHeight,
    primaryHeight,
    originalHeight,
    chromeHeight: 208 + replyHeight + primaryHeight + originalHeight + 96,
  };
}

/**
 * Greedily packs first bands onto the main card, then leaves every remaining
 * band for its own image-only tile card.  The first band always lands on the
 * main card; further first bands only join while the running total stays within
 * `MAX_CARD_HEIGHT - chromeHeight`.  A 24px gap separates different images.
 */
function planImageBands(
  bands: readonly ImageBand[],
  chromeHeight: number,
): { readonly card1Bands: readonly ImageBand[]; readonly tileBands: readonly ImageBand[] } {
  const budget = Math.max(1, MAX_CARD_HEIGHT - chromeHeight);
  const card1Bands: ImageBand[] = [];
  const tileBands: ImageBand[] = [];
  let used = 0;
  for (const band of bands) {
    if (band.first && (card1Bands.length === 0 || used + imageGap + band.h <= budget)) {
      if (card1Bands.length > 0) used += imageGap;
      used += band.h;
      card1Bands.push(band);
    } else {
      tileBands.push(band);
    }
  }
  return { card1Bands, tileBands };
}

/**
 * A pure image card: one band fills the canvas at the standard x/width, with
 * rounded corners only at the image's real top/bottom.  Seam edges are square
 * so consecutive messages stitch without a background notch.
 */
function renderImageTileCard(band: ImageBand): Buffer {
  const canvas = createCanvas(width, band.h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0d13';
  ctx.fillRect(0, 0, width, band.h);
  const radius = Math.min(22, band.h / 2);
  ctx.save();
  roundedRectRadii(ctx, horizontalPadding, 0, band.w, band.h, [
    band.first ? radius : 0,
    band.first ? radius : 0,
    band.last ? radius : 0,
    band.last ? radius : 0,
  ]);
  ctx.clip();
  ctx.drawImage(
    band.image,
    0,
    band.srcY,
    band.image.width,
    band.srcH,
    horizontalPadding,
    0,
    band.w,
    band.h,
  );
  ctx.restore();
  return canvas.toBuffer('image/png');
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

function roundedRectRadii(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radii);
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
          .no-reply { fill: #ff5c5c; font-size: 20px; font-weight: 700; }
          .footer { fill: #737c92; font-size: 17px; }
        </style>
      </defs>
      <rect width="${width}" height="${height}" rx="28" fill="url(#background)"/>
      ${avatar}
      <text x="${horizontalPadding + 98}" y="78" class="sender">${escapeXml(input.senderName)}</text>
      <text x="${horizontalPadding + 98}" y="112" class="meta">${escapeXml(input.sourceName)} · ${escapeXml(input.sentAt)}</text>
      <text x="${width - horizontalPadding}" y="76" text-anchor="end" class="platform">${input.sourcePlatform.toUpperCase()}</text>
      ${
        input.nonReplyable
          ? `<rect x="${width - horizontalPadding - 112}" y="126" width="112" height="44" rx="22"
              fill="#ff5c5c" fill-opacity="0.16" stroke="#ff5c5c" stroke-opacity="0.9" stroke-width="2"/>
             <text x="${width - horizontalPadding - 56}" y="156" text-anchor="middle" class="no-reply">${
               language === 'zh' ? '不可回复' : 'NO REPLY'
             }</text>`
          : ''
      }
      ${replySvg}
      ${primarySvg}
      ${imagesSvg}
      ${originalSvg}
      <text x="${horizontalPadding}" y="${height - 38}" class="footer">DisQord · ${escapeXml(input.traceLabel ?? '')}</text>
    </svg>
  `;
}

function columnWidth(character: string): number {
  return (character.codePointAt(0) ?? 0) <= 0xff ? 1 : 2;
}

function wrapText(text: string, maxColumns: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/gu, '\n').split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let line = '';
    let columns = 0;
    let sawWord = false;
    const flushLine = (): void => {
      if (line) {
        lines.push(line);
        line = '';
        columns = 0;
      }
    };
    for (const match of paragraph.matchAll(/\S+|\s+/gu)) {
      const token = match[0]!;
      if (/^\s+$/u.test(token)) {
        // Keep whitespace only when it follows content on the current line.
        if (line) {
          line += token;
          columns += Array.from(token).reduce((sum, character) => sum + columnWidth(character), 0);
        }
        continue;
      }
      sawWord = true;
      const tokenColumns = Array.from(token).reduce(
        (sum, character) => sum + columnWidth(character),
        0,
      );
      if (tokenColumns > maxColumns) {
        // A single run longer than one line (long URL, unbroken CJK): fall back
        // to column-based hard splitting so nothing is dropped.
        flushLine();
        let chunk = '';
        let chunkColumns = 0;
        for (const character of token) {
          const width = columnWidth(character);
          if (chunkColumns + width > maxColumns && chunk) {
            lines.push(chunk);
            chunk = '';
            chunkColumns = 0;
          }
          chunk += character;
          chunkColumns += width;
        }
        if (chunk) lines.push(chunk);
        continue;
      }
      if (columns === 0) {
        line = token;
        columns = tokenColumns;
        continue;
      }
      if (columns + tokenColumns <= maxColumns) {
        line += token;
        columns += tokenColumns;
        continue;
      }
      // The word does not fit on this line: move the whole word to a new line
      // instead of splitting it mid-word.
      flushLine();
      line = token;
      columns = tokenColumns;
    }
    if (line) {
      lines.push(line);
    } else if (!sawWord) {
      // Paragraph was only whitespace: keep a blank line like the old path.
      lines.push('');
    }
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
