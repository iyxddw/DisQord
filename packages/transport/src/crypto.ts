import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';

import { z } from 'zod';

import { internalIdSchema, isoDateTimeSchema, platformSchema, sha256Schema } from '@disqord/shared';

const pemSchema = z.string().min(64).max(16_384);
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);

export const nodeIdentitySchema = z.object({
  nodeId: internalIdSchema,
  nodeType: platformSchema,
  publicKeyPem: pemSchema,
  privateKeyPem: pemSchema,
});

export type NodeIdentity = z.infer<typeof nodeIdentitySchema>;

export const pairingRequestSchema = z.object({
  nodeId: internalIdSchema,
  nodeType: platformSchema,
  pairingCode: base64UrlSchema.min(8).max(128),
  publicKeyPem: pemSchema,
  nonce: internalIdSchema,
  createdAt: isoDateTimeSchema,
  signature: base64UrlSchema,
});

export type PairingRequest = z.infer<typeof pairingRequestSchema>;

export const secureFrameSchema = z.object({
  frameId: internalIdSchema,
  nodeId: internalIdSchema,
  sequence: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  kind: z.string().trim().min(1).max(128),
  payload: z.unknown(),
  mac: sha256Schema,
});

export type SecureFrame = z.infer<typeof secureFrameSchema>;

export interface UnsignedSecureFrame {
  readonly frameId: string;
  readonly nodeId: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly kind: string;
  readonly payload: unknown;
}

export function generateNodeIdentity(nodeType: 'qq' | 'discord'): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    nodeId: randomUUID(),
    nodeType,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function createPairingRequest(identity: NodeIdentity, pairingCode: string): PairingRequest {
  const unsigned = {
    nodeId: identity.nodeId,
    nodeType: identity.nodeType,
    pairingCode,
    publicKeyPem: identity.publicKeyPem,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const signature = sign(
    null,
    Buffer.from(stableStringify(unsigned)),
    identity.privateKeyPem,
  ).toString('base64url');
  return pairingRequestSchema.parse({ ...unsigned, signature });
}

export function verifyPairingRequestSignature(request: PairingRequest): boolean {
  const parsed = pairingRequestSchema.parse(request);
  const { signature, ...unsigned } = parsed;
  return verify(
    null,
    Buffer.from(stableStringify(unsigned)),
    parsed.publicKeyPem,
    Buffer.from(signature, 'base64url'),
  );
}

export function createSecureFrame(input: UnsignedSecureFrame, sessionToken: string): SecureFrame {
  const unsigned = {
    frameId: input.frameId,
    nodeId: input.nodeId,
    sequence: input.sequence,
    createdAt: input.createdAt,
    kind: input.kind,
    payload: input.payload,
  };
  return secureFrameSchema.parse({
    ...unsigned,
    mac: createHmac('sha256', sessionToken).update(stableStringify(unsigned)).digest('hex'),
  });
}

export function verifySecureFrameMac(frame: SecureFrame, sessionToken: string): boolean {
  const parsed = secureFrameSchema.parse(frame);
  const { mac, ...unsigned } = parsed;
  const expected = createHmac('sha256', sessionToken).update(stableStringify(unsigned)).digest();
  const actual = Buffer.from(mac, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function fingerprintPublicKey(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem).digest('hex');
}

export function hashSecret(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

export function createRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
