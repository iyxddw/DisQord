import { z } from 'zod';

import { internalIdSchema, isoDateTimeSchema } from './common.js';

export const promptPurposeSchema = z.enum([
  'translation-system',
  'translation-task',
  'moderation-system',
  'moderation-rules',
]);

export const promptStatusSchema = z.enum(['draft', 'published', 'archived']);

export const promptTemplateVersionSchema = z.object({
  id: internalIdSchema,
  purpose: promptPurposeSchema,
  version: z.number().int().positive(),
  status: promptStatusSchema,
  content: z.string().trim().min(1).max(50_000),
  createdBy: internalIdSchema,
  createdAt: isoDateTimeSchema,
  publishedAt: isoDateTimeSchema.optional(),
});

export const translationResultSchema = z.object({
  detectedLanguage: z.string().trim().min(2).max(35),
  translatedText: z.string().max(30_000),
  confidence: z.number().min(0).max(1),
  model: z.string().trim().min(1).max(256),
  promptVersion: z.number().int().positive(),
});

export const moderationResultSchema = z.object({
  riskLevel: z.enum(['low', 'medium', 'high']),
  decision: z.enum(['allow', 'review', 'block']),
  categories: z.array(z.string().trim().min(1).max(128)).max(32),
  reason: z.string().trim().min(1).max(4_000),
  confidence: z.number().min(0).max(1),
  model: z.string().trim().min(1).max(256),
  promptVersion: z.number().int().positive(),
});

export type PromptTemplateVersion = z.infer<typeof promptTemplateVersionSchema>;
export type TranslationResult = z.infer<typeof translationResultSchema>;
export type ModerationResult = z.infer<typeof moderationResultSchema>;
