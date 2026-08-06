import { createHash, randomUUID } from 'node:crypto';

import { messageEnvelopeSchema, type MessageEnvelope } from '@disqord/shared';
import { z } from 'zod';

const discordAttachmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  contentType: z.string().nullable().optional(),
  size: z.number().int().nonnegative(),
  url: z.url(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
});

export const discordMentionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
});

export type DiscordMention = z.infer<typeof discordMentionSchema>;

const discordCustomEmojiPattern = /<(a?):([A-Za-z0-9_~]+):(\d+)>/gu;

export const discordMessageSnapshotSchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  content: z.string(),
  type: z.number().int(),
  author: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    avatarUrl: z.url().optional(),
    bot: z.boolean(),
  }),
  attachments: z.array(discordAttachmentSchema),
  stickerCount: z.number().int().nonnegative().default(0),
  mentions: z.array(discordMentionSchema).optional(),
  referencedMessage: z
    .object({
      id: z.string().min(1),
      authorDisplayName: z.string().min(1),
      content: z.string(),
      imageUrl: z.url().optional(),
      mentions: z.array(discordMentionSchema).optional(),
    })
    .optional(),
  referencedMessageId: z.string().min(1).optional(),
});

export type DiscordMessageSnapshot = z.infer<typeof discordMessageSnapshotSchema>;

function replaceDiscordUserMentions(
  text: string,
  mentions: readonly DiscordMention[] | undefined,
  selfUserId?: string,
): string {
  const withoutSelfMention = selfUserId
    ? text.replace(new RegExp(`<@!?${escapeRegExp(selfUserId)}>`, 'gu'), ' ')
    : text;
  if (!mentions?.length) return withoutSelfMention.trim();
  const names = new Map(mentions.map((mention) => [mention.id, mention.displayName]));
  return withoutSelfMention
    .replace(/<@!?(\d+)>/gu, (tag, id: string) => `@${names.get(id) ?? id}`)
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractDiscordCustomEmojis(text: string): MessageEnvelope['customEmojis'] {
  const emojis = new Map<string, NonNullable<MessageEnvelope['customEmojis']>[number]>();
  for (const match of text.matchAll(discordCustomEmojiPattern)) {
    const animated = match[1] === 'a';
    const name = match[2]!;
    const id = match[3]!;
    const token = match[0];
    if (emojis.has(token)) continue;
    emojis.set(token, {
      token,
      name,
      id,
      animated,
      sourceUrl: `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=64&quality=lossless`,
    });
  }
  return emojis.size ? [...emojis.values()].slice(0, 32) : undefined;
}

export function normalizeDiscordMessage(
  candidate: DiscordMessageSnapshot,
  nodeId: string,
  selfUserId?: string,
): MessageEnvelope | undefined {
  const message = discordMessageSnapshotSchema.parse(candidate);
  if (message.author.bot) return undefined;

  const images = message.attachments.filter((attachment) =>
    attachment.contentType?.startsWith('image/'),
  );
  const hasUnsupportedAttachment = images.length !== message.attachments.length;
  const unsupportedType =
    message.stickerCount > 0
      ? 'sticker'
      : hasUnsupportedAttachment
        ? 'file'
        : message.type !== 0 && message.type !== 19
          ? `discord-message-${message.type}`
          : undefined;
  const text = replaceDiscordUserMentions(message.content, message.mentions, selfUserId);
  const customEmojis = extractDiscordCustomEmojis(message.content);
  const attachments: MessageEnvelope['attachments'][number][] = images.map((attachment) => ({
    id: randomUUID(),
    ...(attachment.name ? { fileName: attachment.name.slice(0, 255) } : {}),
    mimeType: attachment.contentType ?? 'image/jpeg',
    byteSize: attachment.size,
    sha256: createHash('sha256').update(attachment.url).digest('hex'),
    sourceUrl: attachment.url,
    ...(attachment.width ? { width: attachment.width } : {}),
    ...(attachment.height ? { height: attachment.height } : {}),
  }));
  const kind = unsupportedType
    ? 'unsupported'
    : attachments.length > 0 && text
      ? 'mixed'
      : attachments.length > 0
        ? 'image'
        : 'text';
  const referenced = message.referencedMessage;
  const replyId = referenced?.id ?? message.referencedMessageId;
  const referencedText = referenced
    ? replaceDiscordUserMentions(referenced.content, referenced.mentions, selfUserId)
    : undefined;
  const referencedCustomEmojis = referenced
    ? extractDiscordCustomEmojis(referenced.content)
    : undefined;

  if (!text && attachments.length === 0 && !unsupportedType) return undefined;

  return messageEnvelopeSchema.parse({
    schemaVersion: 1,
    eventId: randomUUID(),
    source: {
      nodeId,
      platform: 'discord',
      spaceId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
    },
    sender: {
      id: message.author.id,
      displayName: message.author.displayName,
      ...(message.author.avatarUrl ? { avatarUrl: message.author.avatarUrl } : {}),
    },
    sentAt: message.createdAt,
    kind,
    ...(text ? { text } : {}),
    attachments,
    ...(customEmojis ? { customEmojis } : {}),
    ...(unsupportedType ? { unsupportedType } : {}),
    ...(replyId
      ? {
          replyTo: {
            sourceMessageId: replyId,
            senderDisplayName: referenced?.authorDisplayName ?? 'Replied user',
            ...(referencedText ? { textPreview: referencedText.slice(0, 1_000) } : {}),
            ...(referencedCustomEmojis ? { customEmojis: referencedCustomEmojis } : {}),
            ...(referenced?.imageUrl
              ? {
                  imagePreview: {
                    id: randomUUID(),
                    mimeType: 'image/jpeg',
                    byteSize: 0,
                    sha256: createHash('sha256').update(referenced.imageUrl).digest('hex'),
                    sourceUrl: referenced.imageUrl,
                  },
                }
              : {}),
          },
        }
      : {}),
    traceId: randomUUID(),
  });
}
