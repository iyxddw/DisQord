import { z } from 'zod';

import { externalIdSchema, internalIdSchema, isoDateTimeSchema, sha256Schema } from './common.js';
import { platformSchema } from './program.js';

export const chatSessionStatusSchema = z.enum(['pending', 'verified', 'disabled', 'stale']);

export const chatSessionSchema = z.object({
  id: internalIdSchema,
  nodeId: internalIdSchema,
  platform: platformSchema,
  externalId: externalIdSchema,
  spaceId: externalIdSchema,
  displayName: z.string().trim().min(1).max(256),
  remark: z.string().trim().max(256).optional(),
  /** Fetch-only channel: the bot never delivers into it; its own messages still trigger flows. */
  fetchOnly: z.boolean().optional(),
  status: chatSessionStatusSchema,
  verifiedAt: isoDateTimeSchema.optional(),
  lastSuccessfulSendAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const chatSessionVerificationSchema = z.object({
  id: internalIdSchema,
  chatSessionId: internalIdSchema,
  codeDigest: sha256Schema,
  expiresAt: isoDateTimeSchema,
  attemptCount: z.number().int().nonnegative(),
  consumedAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
});

export type ChatSession = z.infer<typeof chatSessionSchema>;
export type ChatSessionVerification = z.infer<typeof chatSessionVerificationSchema>;
