import { createHash, randomUUID } from 'node:crypto';

import { messageEnvelopeSchema, type MessageEnvelope } from '@disqord/shared';
import { z } from 'zod';

const segmentSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type NapCatMessageSegment = z.infer<typeof segmentSchema>;

const napCatFacePattern = /\[CQ:face,id=(\d+)\]/gu;

export const napCatGroupMessageEventSchema = z.object({
  post_type: z.literal('message'),
  message_type: z.literal('group'),
  message_id: z.union([z.string(), z.number()]),
  self_id: z.union([z.string(), z.number()]),
  user_id: z.union([z.string(), z.number()]),
  group_id: z.union([z.string(), z.number()]),
  time: z.number().int().nonnegative(),
  message: z.array(segmentSchema),
  sender: z
    .object({
      nickname: z.string().optional(),
      card: z.string().optional(),
    })
    .default({}),
});

export type NapCatGroupMessageEvent = z.infer<typeof napCatGroupMessageEventSchema>;

export interface NapCatReplyPreview {
  readonly senderDisplayName: string;
  readonly textPreview?: string;
  readonly customEmojis?: MessageEnvelope['customEmojis'];
  readonly imageUrl?: string;
}

export function createNapCatFaceToken(faceId: string): string {
  return `[CQ:face,id=${faceId}]`;
}

export function extractNapCatFaceIds(segments: readonly NapCatMessageSegment[]): string[] {
  const ids = new Set<string>();
  for (const segment of segments) {
    if (segment.type === 'face') {
      const faceId = String(segment.data.id ?? '').trim();
      if (/^\d+$/u.test(faceId)) ids.add(faceId);
    }
    if (segment.type === 'text') {
      for (const match of String(segment.data.text ?? '').matchAll(napCatFacePattern)) {
        ids.add(match[1]!);
      }
    }
  }
  return [...ids];
}

export function createNapCatCustomEmojis(
  segments: readonly NapCatMessageSegment[],
): MessageEnvelope['customEmojis'] {
  const emojis = new Map<string, NonNullable<MessageEnvelope['customEmojis']>[number]>();
  for (const faceId of extractNapCatFaceIds(segments)) {
    const token = createNapCatFaceToken(faceId);
    if (emojis.has(token)) continue;
    emojis.set(token, {
      token,
      name: `qq-face-${faceId}`,
      id: faceId,
      animated: false,
    });
  }
  return emojis.size ? [...emojis.values()].slice(0, 32) : undefined;
}

export function normalizeNapCatGroupMessage(
  candidate: unknown,
  nodeId: string,
  mentionNames: ReadonlyMap<string, string> = new Map(),
  replyPreviews: ReadonlyMap<string, NapCatReplyPreview> = new Map(),
): MessageEnvelope | undefined {
  const event = napCatGroupMessageEventSchema.parse(candidate);
  const fromSelf = String(event.user_id) === String(event.self_id);

  const textParts: string[] = [];
  const attachments: MessageEnvelope['attachments'][number][] = [];
  let replyTo: MessageEnvelope['replyTo'];
  let unsupportedType: string | undefined;

  for (const segment of event.message) {
    if (segment.type === 'text') {
      textParts.push(String(segment.data.text ?? ''));
    } else if (segment.type === 'at') {
      const mentionedId = String(segment.data.qq ?? 'unknown');
      if (mentionedId === String(event.self_id)) continue;
      textParts.push(
        mentionedId === 'all' ? '@全体成员' : `@${mentionNames.get(mentionedId) ?? mentionedId}`,
      );
    } else if (segment.type === 'face') {
      const faceId = String(segment.data.id ?? '').trim();
      if (faceId) textParts.push(createNapCatFaceToken(faceId));
      else unsupportedType ??= 'face';
    } else if (segment.type === 'image') {
      const sourceUrl = typeof segment.data.url === 'string' ? segment.data.url : undefined;
      const file = String(segment.data.file ?? 'image');
      attachments.push({
        id: randomUUID(),
        fileName: file.slice(0, 255),
        mimeType: guessImageMime(file, sourceUrl),
        byteSize: 0,
        sha256: createHash('sha256')
          .update(sourceUrl ?? file)
          .digest('hex'),
        ...(sourceUrl ? { sourceUrl } : {}),
      });
    } else if (segment.type === 'reply') {
      const sourceMessageId = String(segment.data.id ?? '');
      const preview = replyPreviews.get(sourceMessageId);
      replyTo = {
        sourceMessageId,
        senderDisplayName: preview?.senderDisplayName ?? '被回复用户',
        ...(preview?.textPreview ? { textPreview: preview.textPreview.slice(0, 1_000) } : {}),
        ...(preview?.customEmojis ? { customEmojis: preview.customEmojis } : {}),
        ...(preview?.imageUrl
          ? {
              imagePreview: {
                id: randomUUID(),
                mimeType: guessImageMime('reply-image', preview.imageUrl),
                byteSize: 0,
                sha256: createHash('sha256').update(preview.imageUrl).digest('hex'),
                sourceUrl: preview.imageUrl,
              },
            }
          : {}),
      };
    } else {
      unsupportedType ??= segment.type;
    }
  }

  const text = textParts.join('').trim();
  if (!text && attachments.length === 0 && !unsupportedType) return undefined;
  const kind = unsupportedType
    ? 'unsupported'
    : attachments.length > 0 && text
      ? 'mixed'
      : attachments.length > 0
        ? 'image'
        : 'text';
  const groupId = String(event.group_id);
  const userId = String(event.user_id);
  const customEmojis = createNapCatCustomEmojis(event.message);

  return messageEnvelopeSchema.parse({
    schemaVersion: 1,
    eventId: randomUUID(),
    source: {
      nodeId,
      platform: 'qq',
      spaceId: groupId,
      channelId: groupId,
      messageId: String(event.message_id),
    },
    sender: {
      id: userId,
      displayName: event.sender.card?.trim() || event.sender.nickname?.trim() || userId,
      avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(userId)}&s=640`,
    },
    sentAt: new Date(event.time * 1_000).toISOString(),
    fromSelf,
    kind,
    ...(text ? { text } : {}),
    attachments,
    ...(customEmojis ? { customEmojis } : {}),
    ...(unsupportedType ? { unsupportedType } : {}),
    ...(replyTo?.sourceMessageId ? { replyTo } : {}),
    traceId: randomUUID(),
  });
}

function guessImageMime(file: string, url?: string): string {
  const value = `${file} ${url ?? ''}`.toLowerCase();
  if (value.includes('.gif')) return 'image/gif';
  if (value.includes('.webp')) return 'image/webp';
  if (value.includes('.png')) return 'image/png';
  return 'image/jpeg';
}
