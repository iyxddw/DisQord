import { z } from 'zod';

import { internalIdSchema, isoDateTimeSchema } from './common.js';
import { messageEnvelopeSchema } from './message.js';

export const taskStatusSchema = z.enum([
  'received',
  'blueprint_matched',
  'moderating',
  'translating',
  'rendering',
  'queued',
  'sent',
  'acknowledged',
  'pending_review',
  'retrying',
  'blocked',
  'dead_letter',
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

const allowedTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  received: ['blueprint_matched', 'blocked', 'dead_letter'],
  blueprint_matched: ['moderating', 'blocked', 'dead_letter'],
  moderating: ['translating', 'pending_review', 'blocked', 'retrying', 'dead_letter'],
  translating: ['rendering', 'pending_review', 'retrying', 'dead_letter'],
  rendering: ['queued', 'retrying', 'dead_letter'],
  queued: ['sent', 'retrying', 'dead_letter'],
  sent: ['acknowledged', 'retrying', 'dead_letter'],
  acknowledged: [],
  pending_review: ['translating', 'rendering', 'blocked', 'dead_letter'],
  retrying: ['moderating', 'translating', 'rendering', 'queued', 'sent', 'dead_letter'],
  blocked: [],
  dead_letter: ['retrying'],
};

export const deliveryTaskSchema = z.object({
  id: internalIdSchema,
  traceId: internalIdSchema,
  blueprintId: internalIdSchema,
  blueprintVersion: z.number().int().positive(),
  targetSessionId: internalIdSchema,
  status: taskStatusSchema,
  attempts: z.number().int().nonnegative(),
  message: messageEnvelopeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  lastErrorCode: z.string().trim().min(1).max(128).optional(),
});

export const traceEventSchema = z.object({
  id: internalIdSchema,
  traceId: internalIdSchema,
  nodeId: internalIdSchema.optional(),
  blueprintId: internalIdSchema.optional(),
  blueprintVersion: z.number().int().positive().optional(),
  chatSessionId: internalIdSchema.optional(),
  stage: taskStatusSchema,
  outcome: z.enum(['started', 'succeeded', 'failed', 'skipped']),
  durationMs: z.number().int().nonnegative().optional(),
  errorCode: z.string().trim().min(1).max(128).optional(),
  createdAt: isoDateTimeSchema,
});

export type DeliveryTask = z.infer<typeof deliveryTaskSchema>;
export type TraceEvent = z.infer<typeof traceEventSchema>;

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}
