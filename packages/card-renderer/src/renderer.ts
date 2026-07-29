import sharp from 'sharp';
import { z } from 'zod';

const dataImageSchema = z.string().regex(/^data:image\/(?:png|jpeg|webp|gif);base64,/u);

export const messageCardInputSchema = z.object({
  sourcePlatform: z.enum(['qq', 'discord']),
  sourceName: z.string().trim().min(1).max(256),
  senderName: z.string().trim().min(1).max(256),
  senderAvatar: dataImageSchema.optional(),
  sentAt: z.string().min(1).max(128),
  primaryText: z.string().max(30_000),
  originalText: z.string().max(30_000).optional(),
  images: z.array(dataImageSchema).max(10).default([]),
  reply: z
    .object({
      senderName: z.string().trim().min(1).max(256),
      textPreview: z.string().max(1_000).optional(),
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

export async function renderMessageCards(candidate: MessageCardInput): Promise<Buffer[]> {
  const input = messageCardInputSchema.parse(candidate);
  const primaryPages = paginateText(
    input.unsupportedType
      ? `不支持的消息\nUnsupported message type\n${input.unsupportedType}`
      : input.primaryText,
    34,
  );
  const originalPages = input.originalText ? paginateText(input.originalText, 28) : [[]];
  const pageCount = Math.max(primaryPages.length, originalPages.length, 1);
  const cards: Buffer[] = [];

  for (let page = 0; page < pageCount; page += 1) {
    const svg = buildMessageCardSvg({
      ...input,
      primaryText: (primaryPages[page] ?? []).join('\n'),
      ...(input.originalText ? { originalText: (originalPages[page] ?? []).join('\n') } : {}),
      images: page === 0 ? input.images : [],
      ...(pageCount > 1
        ? { traceLabel: `${input.traceLabel ?? ''} ${page + 1}/${pageCount}`.trim() }
        : {}),
    });
    cards.push(await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer());
  }
  return cards;
}

export function buildMessageCardSvg(candidate: MessageCardInput): string {
  const input = messageCardInputSchema.parse(candidate);
  const primaryLines = wrapText(
    input.unsupportedType
      ? `不支持的消息\nUnsupported message type\n${input.unsupportedType}`
      : input.primaryText,
    42,
  );
  const replyLines = input.reply?.textPreview
    ? wrapText(input.reply.textPreview, 52).slice(0, 4)
    : [];
  const originalLines = input.originalText ? wrapText(input.originalText, 52) : [];
  const replyHeight = input.reply ? 88 + replyLines.length * 32 : 0;
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
          <text x="${horizontalPadding + 28}" y="${top + 38}" class="original-label">原文 · ORIGINAL</text>
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
          text { font-family: "Noto Sans CJK SC", "Microsoft YaHei", "Segoe UI Emoji", sans-serif; }
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
