import { createHash } from 'node:crypto';

import { z } from 'zod';

import { externalIdSchema, internalIdSchema, isoDateTimeSchema, sha256Schema } from './common.js';
import { platformSchema } from './program.js';

export const messageKindSchema = z.enum(['text', 'image', 'mixed', 'unsupported']);

export const mediaReferenceSchema = z.object({
  id: internalIdSchema,
  fileName: z.string().trim().min(1).max(255).optional(),
  mimeType: z.string().trim().min(1).max(127),
  byteSize: z.number().int().nonnegative(),
  sha256: sha256Schema,
  sourceUrl: z.url().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const customEmojiReferenceSchema = z
  .object({
    /** The exact platform token as it appeared in the message body. */
    token: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(64),
    id: externalIdSchema,
    animated: z.boolean(),
    sourceUrl: z.url().optional(),
    dataUri: z
      .string()
      .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,/u)
      .max(2 * 1024 * 1024)
      .optional(),
  });

export const replyReferenceSchema = z.object({
  sourceMessageId: externalIdSchema,
  targetMessageId: externalIdSchema.optional(),
  senderId: externalIdSchema.optional(),
  senderDisplayName: z.string().trim().min(1).max(256),
  textPreview: z.string().max(1_000).optional(),
  customEmojis: z.array(customEmojiReferenceSchema).max(32).optional(),
  imagePreview: mediaReferenceSchema.optional(),
});

export const messageEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: internalIdSchema,
    source: z.object({
      nodeId: internalIdSchema,
      platform: platformSchema,
      spaceId: externalIdSchema,
      channelId: externalIdSchema,
      messageId: externalIdSchema,
    }),
    sender: z.object({
      id: externalIdSchema,
      displayName: z.string().trim().min(1).max(256),
      avatarUrl: z.url().optional(),
    }),
    sentAt: isoDateTimeSchema,
    kind: messageKindSchema,
    text: z.string().max(20_000).optional(),
    attachments: z.array(mediaReferenceSchema).max(10).default([]),
    customEmojis: z.array(customEmojiReferenceSchema).max(32).optional(),
    unsupportedType: z.string().trim().min(1).max(128).optional(),
    replyTo: replyReferenceSchema.optional(),
    traceId: internalIdSchema,
  })
  .superRefine((message, context) => {
    const hasText = Boolean(message.text?.trim());
    const hasAttachments = message.attachments.length > 0;

    if (message.kind === 'text' && !hasText) {
      context.addIssue({
        code: 'custom',
        message: 'Text messages require non-empty text.',
        path: ['text'],
      });
    }

    if (message.kind === 'image' && !hasAttachments) {
      context.addIssue({
        code: 'custom',
        message: 'Image messages require at least one attachment.',
        path: ['attachments'],
      });
    }

    if (message.kind === 'mixed' && (!hasText || !hasAttachments)) {
      context.addIssue({
        code: 'custom',
        message: 'Mixed messages require both text and attachments.',
      });
    }

    if (message.kind === 'unsupported' && !message.unsupportedType) {
      context.addIssue({
        code: 'custom',
        message: 'Unsupported messages require the source message type.',
        path: ['unsupportedType'],
      });
    }
  });

export type MessageEnvelope = z.infer<typeof messageEnvelopeSchema>;
export type ReplyReference = z.infer<typeof replyReferenceSchema>;
export type MediaReference = z.infer<typeof mediaReferenceSchema>;
export type CustomEmojiReference = z.infer<typeof customEmojiReferenceSchema>;

/**
 * Upload envelope used by nodes when several messages are coalesced during a
 * poor network window.  The individual envelopes remain authoritative so
 * the central server can preserve their order and idempotency semantics.
 */
export const messageUploadBatchSchema = z.object({
  batchId: internalIdSchema.optional(),
  messages: z.array(messageEnvelopeSchema).min(1).max(25),
});

export type MessageUploadBatch = z.infer<typeof messageUploadBatchSchema>;

export function createMessageIdempotencyKey(message: MessageEnvelope): string {
  return createHash('sha256')
    .update(
      [
        message.source.nodeId,
        message.source.platform,
        message.source.channelId,
        message.source.messageId,
      ].join('\u001f'),
    )
    .digest('hex');
}
