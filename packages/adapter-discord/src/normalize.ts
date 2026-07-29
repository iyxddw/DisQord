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
  referencedMessage: z
    .object({
      id: z.string().min(1),
      authorDisplayName: z.string().min(1),
      content: z.string(),
      imageUrl: z.url().optional(),
    })
    .optional(),
  referencedMessageId: z.string().min(1).optional(),
});

export type DiscordMessageSnapshot = z.infer<typeof discordMessageSnapshotSchema>;

export function normalizeDiscordMessage(
  candidate: DiscordMessageSnapshot,
  nodeId: string,
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
  const text = message.content.trim();
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
    ...(unsupportedType ? { unsupportedType } : {}),
    ...(replyId
      ? {
          replyTo: {
            sourceMessageId: replyId,
            senderDisplayName: referenced?.authorDisplayName ?? 'Replied user',
            ...(referenced?.content ? { textPreview: referenced.content.slice(0, 1_000) } : {}),
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
