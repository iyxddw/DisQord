import { z } from 'zod';

import { internalIdSchema, isoDateTimeSchema, positionSchema } from './common.js';

export const blueprintNodeTypeSchema = z.enum([
  'chat-input',
  'chat-output',
  'message-type-filter',
  'text-condition',
  'llm-moderation',
  'llm-translation',
  'card-renderer',
  'manual-review',
  'split',
  'merge',
  'rate-limit',
  'discard',
  'log-marker',
]);

export const blueprintNodeSchema = z.object({
  id: internalIdSchema,
  type: blueprintNodeTypeSchema,
  position: positionSchema,
  config: z.record(z.string(), z.unknown()),
});

export const blueprintEdgeSchema = z.object({
  id: internalIdSchema,
  sourceNodeId: internalIdSchema,
  targetNodeId: internalIdSchema,
  sourceHandle: z.string().trim().min(1).max(64).optional(),
  targetHandle: z.string().trim().min(1).max(64).optional(),
});

export const blueprintVersionSchema = z.object({
  id: internalIdSchema,
  blueprintId: internalIdSchema,
  version: z.number().int().positive(),
  status: z.enum(['draft', 'published', 'archived']),
  nodes: z.array(blueprintNodeSchema).max(500),
  edges: z.array(blueprintEdgeSchema).max(1_000),
  createdBy: internalIdSchema,
  createdAt: isoDateTimeSchema,
  publishedAt: isoDateTimeSchema.optional(),
});

export const blueprintSchema = z.object({
  id: internalIdSchema,
  name: z.string().trim().min(1).max(256),
  enabled: z.boolean(),
  activeVersion: z.number().int().positive().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type Blueprint = z.infer<typeof blueprintSchema>;
export type BlueprintVersion = z.infer<typeof blueprintVersionSchema>;
export type BlueprintNode = z.infer<typeof blueprintNodeSchema>;
export type BlueprintEdge = z.infer<typeof blueprintEdgeSchema>;
