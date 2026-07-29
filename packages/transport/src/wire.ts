import { z } from 'zod';

import { internalIdSchema, platformSchema } from '@disqord/shared';

import { pairingRequestSchema, secureFrameSchema } from './crypto.js';

export const clientWireMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pair.request'),
    request: pairingRequestSchema,
  }),
  z.object({
    type: z.literal('auth.request'),
    nodeId: internalIdSchema,
    nodeType: platformSchema,
    sessionToken: z.string().min(32).max(512),
  }),
  z.object({
    type: z.literal('frame'),
    frame: secureFrameSchema,
  }),
  z.object({
    type: z.literal('command.ack'),
    frameId: internalIdSchema,
  }),
]);

export const serverWireMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pair.accepted'),
    nodeId: internalIdSchema,
    sessionToken: z.string().min(32).max(512),
    publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  z.object({
    type: z.literal('auth.accepted'),
    nodeId: internalIdSchema,
  }),
  z.object({
    type: z.literal('frame.ack'),
    frameId: internalIdSchema,
  }),
  z.object({
    type: z.literal('command'),
    frame: secureFrameSchema,
  }),
  z.object({
    type: z.literal('error'),
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(1_000),
  }),
]);

export type ClientWireMessage = z.infer<typeof clientWireMessageSchema>;
export type ServerWireMessage = z.infer<typeof serverWireMessageSchema>;

export function parseWireJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return JSON.parse(value) as unknown;
  }
  if (Buffer.isBuffer(value)) {
    return JSON.parse(value.toString('utf8')) as unknown;
  }
  if (Array.isArray(value)) {
    return JSON.parse(Buffer.concat(value).toString('utf8')) as unknown;
  }
  if (value instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(value).toString('utf8')) as unknown;
  }
  throw new Error('Unsupported WebSocket payload type.');
}
