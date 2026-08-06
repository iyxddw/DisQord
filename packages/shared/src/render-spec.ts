import { z } from 'zod';

import { platformSchema } from './program.js';

const imageDataUriPattern = /^data:image\/(?:png|jpeg|webp|gif);base64,/u;

export const avatarKeySchema = z.string().trim().min(1).max(512);
export const avatarDataUriSchema = z
  .string()
  .regex(imageDataUriPattern)
  .max(512 * 1024);

export const avatarRequestSchema = z.object({
  requestId: z.uuid(),
  avatarKey: avatarKeySchema,
});

export const avatarResponseSchema = z.object({
  requestId: z.uuid(),
  avatarKey: avatarKeySchema,
  dataUri: avatarDataUriSchema.optional(),
});

export function createAvatarKey(
  platform: z.infer<typeof platformSchema>,
  senderId: string,
): string {
  return `${platform}:${senderId}`;
}

/**
 * Media metadata used by a card render request. Image-bearing messages are
 * rendered centrally; the client-side path normally has an empty image list.
 *
 * The central server normalizes each image to PNG before using this spec for
 * its own render pass. Keeping this shape shared lets the target node validate
 * durable client-render requests without accepting external media URLs.
 */
export const messageCardMediaSchema = z.object({
  /** A normalized image payload sent to the target node. */
  dataUri: z
    .string()
    .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,/u)
    .max(15 * 1024 * 1024),
  mimeType: z.string().trim().min(1).max(127).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export const messageCardInlineEmojiSchema = z.object({
  /** The exact source token that is replaced by the inline image. */
  token: z.string().trim().min(1).max(128),
  /** Normalized image data sent with the render request. */
  dataUri: z
    .string()
    .regex(imageDataUriPattern)
    .max(2 * 1024 * 1024),
});

export const messageCardRenderSpecSchema = z.object({
  sourcePlatform: platformSchema,
  targetLanguage: z.enum(['zh', 'en']),
  sourceName: z.string().trim().min(1).max(256),
  senderName: z.string().trim().min(1).max(256),
  /** Stable platform/user reference. The node resolves the image on cache miss. */
  senderAvatarKey: avatarKeySchema.optional(),
  /** Internal/legacy form used when the central server renders a card. */
  senderAvatar: avatarDataUriSchema.optional(),
  sentAt: z.string().min(1).max(128),
  primaryText: z.string().max(30_000),
  originalText: z.string().max(30_000).optional(),
  images: z.array(messageCardMediaSchema).max(10).default([]),
  inlineEmojis: z.array(messageCardInlineEmojiSchema).max(32).optional(),
  reply: z
    .object({
      senderName: z.string().trim().min(1).max(256),
      textPreview: z.string().max(1_000).optional(),
      inlineEmojis: z.array(messageCardInlineEmojiSchema).max(32).optional(),
      imagePreview: messageCardMediaSchema.optional(),
    })
    .optional(),
  unsupportedType: z.string().trim().min(1).max(128).optional(),
  traceLabel: z.string().trim().min(1).max(64).optional(),
});

export type MessageCardMedia = z.infer<typeof messageCardMediaSchema>;
export type MessageCardInlineEmoji = z.infer<typeof messageCardInlineEmojiSchema>;
export type MessageCardRenderSpec = z.infer<typeof messageCardRenderSpecSchema>;
