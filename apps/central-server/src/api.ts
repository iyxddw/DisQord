import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { simulateBlueprint, validateBlueprint } from '@disqord/blueprint';
import { llmProviderSettingsSchema, llmSettingsSchema } from '@disqord/llm';
import {
  blueprintVersionSchema,
  blueprintSchema,
  cardSettingsSchema,
  cardThemes,
  chatSessionSchema,
  messageEnvelopeSchema,
  promptPurposeSchema,
  promptTemplateVersionSchema,
  type Blueprint,
  type BlueprintVersion,
  type ChatSession,
  type PromptTemplateVersion,
} from '@disqord/shared';
import {
  CentralNodeGateway,
  PairingAuthority,
  type NodeSession,
  type ReceivedNodeFrame,
} from '@disqord/transport';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { CentralAuthService } from './auth.js';
import { type SecretStore, type StateStore } from './state-store.js';

const passwordBodySchema = z.object({ password: z.string().min(12).max(256) });
const sessionCandidateSchema = z.object({
  nodeId: z.uuid(),
  platform: z.enum(['qq', 'discord']),
  externalId: z.string().min(1).max(256),
  spaceId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(256).optional(),
  fetchOnly: z.boolean().optional(),
});
const sessionUpdateSchema = z
  .object({
    remark: z.string().trim().max(256).nullable().optional(),
    fetchOnly: z.boolean().optional(),
  })
  .refine((value) => value.remark !== undefined || value.fetchOnly !== undefined, {
    message: 'At least one session field must be updated.',
  });
const simulationSettingsSchema = z.object({
  delayMs: z.number().int().min(0).max(10_000).default(1_000),
});
const nodeLogPageSchema = z.object({
  items: z.array(
    z.object({
      createdAt: z.string(),
      level: z.enum(['debug', 'info', 'warn', 'error']),
      event: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().positive(),
});
const nodeLogResponseSchema = z.object({
  requestId: z.uuid(),
  page: nodeLogPageSchema,
});
const llmProviderInputSchema = llmProviderSettingsSchema.extend({
  apiKey: z.string().min(1).max(10_000).optional(),
});
const normalizedLlmSettingsInputSchema = z.object({
  providers: z.array(llmProviderInputSchema).min(1).max(12),
  concurrency: z.number().int().min(1).max(100).default(4),
  fastMode: z.boolean().default(false),
  fastDeliveryIntervalMs: z.number().int().min(0).max(60_000).default(1_500),
});
const llmSettingsInputSchema = z.preprocess((candidate) => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
  const value = candidate as Record<string, unknown>;
  if (Array.isArray(value.providers)) return value;
  if (typeof value.baseUrl !== 'string') return value;
  const providerKeys = [
    'baseUrl',
    'apiKey',
    'translationEnabled',
    'moderationEnabled',
    'imageModerationEnabled',
    'translationModel',
    'moderationModel',
    'imageModerationModel',
    'imageModerationDetail',
    'maxImageCount',
    'maxImageBytes',
    'timeoutMs',
    'maxRetries',
    'retryDelayMs',
    'maxTokens',
    'translationTemperature',
    'moderationTemperature',
    'responseFormatMode',
  ] as const;
  const provider = Object.fromEntries(
    providerKeys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  );
  return {
    providers: [{ id: 'legacy-provider', name: '默认模型', enabled: true, ...provider }],
    ...(value.concurrency === undefined ? {} : { concurrency: value.concurrency }),
    ...(value.fastMode === undefined ? {} : { fastMode: value.fastMode }),
    ...(value.fastDeliveryIntervalMs === undefined
      ? {}
      : { fastDeliveryIntervalMs: value.fastDeliveryIntervalMs }),
  };
}, normalizedLlmSettingsInputSchema);
const promptDraftBodySchema = z.object({ content: z.string().min(1).max(50_000) });
const blueprintDraftBodySchema = z.object({
  name: z.string().min(1).max(256),
  nodes: blueprintVersionSchema.shape.nodes,
  edges: blueprintVersionSchema.shape.edges,
});
const blueprintUpdateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.enabled !== undefined, {
    message: 'At least one blueprint field must be updated.',
  });

interface VerificationRecord {
  readonly digest: string;
  readonly expiresAt: string;
  readonly sentAt: string;
  readonly attemptCount: number;
}

interface PendingNodeLogRequest {
  readonly resolve: (page: z.infer<typeof nodeLogPageSchema>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface CentralApplicationOptions {
  readonly store: StateStore;
  readonly secrets: SecretStore;
  readonly pairingAuthority: PairingAuthority;
  readonly verificationSecret: string;
  readonly secureCookies?: boolean;
  readonly attachNodeGateway?: boolean;
  readonly staticRoot?: string;
  readonly onNodeFrame?: (frame: ReceivedNodeFrame) => void | Promise<void>;
  readonly onReviewAction?: (
    taskId: string,
    decision: 'approve' | 'reject',
  ) => void | Promise<void>;
  readonly onSimulatedInput?: (
    blueprintId: string,
    nodeId: string,
    text: string,
  ) => Promise<{ traceId: string }>;
}

export function createCentralApplication(options: CentralApplicationOptions) {
  const app = Fastify({
    logger: {
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.apiKey',
        '*.sessionToken',
      ],
    },
    bodyLimit: 2 * 1024 * 1024,
  });
  const auth = new CentralAuthService(options.store);
  let gateway: CentralNodeGateway | undefined;
  const pendingNodeLogRequests = new Map<string, PendingNodeLogRequest>();
  const nodeRuntimeWrites = new Map<string, { lastFrameKind: string; writtenAt: number }>();

  void app.register(cookie);

  if (options.attachNodeGateway) {
    gateway = new CentralNodeGateway({
      server: app.server,
      pairingAuthority: options.pairingAuthority,
      onPairingAccepted: async (_acceptance, session) => {
        await options.store.set('node-session', session.nodeId, session);
        await options.store.set('node-runtime', session.nodeId, {
          nodeId: session.nodeId,
          nodeType: session.nodeType,
          verificationStatus: 'pending',
          pairedAt: new Date().toISOString(),
        });
      },
      onFrame: async (frame) => {
        if (frame.kind === 'node.logs.response') {
          const parsed = nodeLogResponseSchema.safeParse(frame.payload);
          if (parsed.success) {
            const pending = pendingNodeLogRequests.get(parsed.data.requestId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingNodeLogRequests.delete(parsed.data.requestId);
              pending.resolve(parsed.data.page);
              return;
            }
          }
        }
        const now = Date.now();
        const previousWrite = nodeRuntimeWrites.get(frame.nodeId);
        if (
          !previousWrite ||
          previousWrite.lastFrameKind !== frame.kind ||
          now - previousWrite.writtenAt >= 30_000
        ) {
          const previous = await options.store.get<Record<string, unknown>>(
            'node-runtime',
            frame.nodeId,
          );
          await options.store.set('node-runtime', frame.nodeId, {
            ...(previous?.value ?? {}),
            nodeId: frame.nodeId,
            nodeType: frame.nodeType,
            lastFrameKind: frame.kind,
            lastSeenAt: new Date(now).toISOString(),
          });
          nodeRuntimeWrites.set(frame.nodeId, { lastFrameKind: frame.kind, writtenAt: now });
        }
        await options.onNodeFrame?.(frame);
      },
    });
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin && host && new URL(origin).host !== host) {
      await reply.code(403).send({ error: 'Cross-origin mutation rejected.' });
    }
  });

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const valid = await auth.authenticate(request.cookies.disqord_session);
    if (!valid) await reply.code(401).send({ error: 'Authentication required.' });
  };

  const broadcastRuntimeSettings = async (
    fastMode: boolean,
    fastDeliveryIntervalMs: number,
  ): Promise<void> => {
    if (!gateway) return;
    const nodes = await options.store.list<NodeSession>('node-session');
    const online = nodes.filter(
      (entry) => !entry.value.revoked && gateway?.isNodeConnected(entry.value.nodeId),
    );
    await Promise.allSettled(
      online.map(async (entry) => {
        try {
          await gateway!.sendToNode(entry.value.nodeId, 'node.runtime.settings', {
            fastMode,
            fastDeliveryIntervalMs,
          });
        } catch (error) {
          // A node may disconnect while settings are being saved.  It will
          // request the current value again after its next reconnect.
          app.log.warn(
            {
              nodeId: entry.value.nodeId,
              error: error instanceof Error ? error.message : String(error),
            },
            'runtime settings broadcast failed',
          );
        }
      }),
    );
  };

  app.get('/api/health', async () => ({
    status: 'ok',
    now: new Date().toISOString(),
  }));

  app.get('/api/auth/status', async (request) => ({
    configured: await auth.isConfigured(),
    authenticated: await auth.authenticate(request.cookies.disqord_session),
  }));

  app.post('/api/auth/setup', async (request, reply) => {
    try {
      const { password } = passwordBodySchema.parse(request.body);
      const token = await auth.setup(password);
      setSessionCookie(reply, token, options.secureCookies ?? true);
      return { ok: true };
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    try {
      const { password } = passwordBodySchema.parse(request.body);
      const token = await auth.login(password);
      setSessionCookie(reply, token, options.secureCookies ?? true);
      return { ok: true };
    } catch {
      return await reply.code(401).send({ error: 'Invalid administrator password.' });
    }
  });

  app.post('/api/auth/logout', { preHandler: requireAdmin }, async (request, reply) => {
    await auth.logout(request.cookies.disqord_session);
    reply.clearCookie('disqord_session', { path: '/' });
    return { ok: true };
  });

  app.get('/api/nodes', { preHandler: requireAdmin }, async () => {
    const runtime = await options.store.list<Record<string, unknown>>('node-runtime');
    const sessions = await options.store.list<Record<string, unknown>>('node-session');
    const chatSessions = await options.store.list<ChatSession>('chat-session');
    const verifiedByNode = new Map<string, ChatSession[]>();
    for (const session of chatSessions.map((entry) => entry.value)) {
      if (session.status !== 'verified') continue;
      verifiedByNode.set(session.nodeId, [...(verifiedByNode.get(session.nodeId) ?? []), session]);
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const entry of sessions) {
      byId.set(entry.key, {
        nodeId: entry.key,
        nodeType: entry.value.nodeType,
        revoked: entry.value.revoked,
      });
    }
    for (const entry of runtime) {
      byId.set(entry.key, { ...byId.get(entry.key), ...entry.value });
    }
    return [...byId.values()].map((node) => ({
      ...node,
      verificationStatus:
        typeof node.nodeId === 'string' && verifiedByNode.has(node.nodeId) ? 'verified' : 'pending',
      ...(typeof node.nodeId === 'string' && verifiedByNode.has(node.nodeId)
        ? { configuredSessions: verifiedByNode.get(node.nodeId) }
        : {}),
      online:
        typeof node.nodeId === 'string' ? (gateway?.isNodeConnected(node.nodeId) ?? false) : false,
    }));
  });

  app.post('/api/nodes/:id/revoke', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      options.pairingAuthority.revoke(id);
      const session = options.pairingAuthority.getSession(id);
      if (session) await options.store.set('node-session', id, session);
      gateway?.disconnectNode(id);
      return { ok: true };
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get('/api/settings/llm', { preHandler: requireAdmin }, async () => {
    const entry = await options.store.get('settings', 'llm');
    if (!entry) {
      return { providers: [], concurrency: 4, fastMode: false, fastDeliveryIntervalMs: 1_500 };
    }
    const settings = llmSettingsSchema.parse(entry.value);
    const legacySecretConfigured = await options.secrets.has('llm-api-key');
    return {
      ...settings,
      providers: await Promise.all(
        settings.providers.map(async (provider, index) => ({
          ...provider,
          apiKeyConfigured:
            (await options.secrets.has(`llm-api-key:${provider.id}`)) ||
            (index === 0 && legacySecretConfigured),
        })),
      ),
    };
  });

  app.put('/api/settings/llm', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const input = llmSettingsInputSchema.parse(request.body);
      const providers = input.providers.map((provider) =>
        llmProviderSettingsSchema.parse(provider),
      );
      const settings = llmSettingsSchema.parse({
        providers,
        concurrency: input.concurrency,
        fastMode: input.fastMode,
        fastDeliveryIntervalMs: input.fastDeliveryIntervalMs,
      });
      await Promise.all(
        input.providers.map(async (provider) => {
          if (provider.apiKey) {
            await options.secrets.set(`llm-api-key:${provider.id}`, provider.apiKey);
          }
        }),
      );
      await options.store.set('settings', 'llm', settings);
      void broadcastRuntimeSettings(settings.fastMode, settings.fastDeliveryIntervalMs);
      return {
        ...settings,
        providers: await Promise.all(
          settings.providers.map(async (provider, index) => ({
            ...provider,
            apiKeyConfigured:
              (await options.secrets.has(`llm-api-key:${provider.id}`)) ||
              (index === 0 && (await options.secrets.has('llm-api-key'))),
          })),
        ),
      };
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get('/api/settings/card', { preHandler: requireAdmin }, async () => {
    const entry = await options.store.get('settings', 'card');
    return {
      ...cardSettingsSchema.parse(entry?.value ?? {}),
      themes: cardThemes,
    };
  });

  app.put('/api/settings/card', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const settings = cardSettingsSchema.parse(request.body);
      await options.store.set('settings', 'card', settings);
      return { ...settings, themes: cardThemes };
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get('/api/settings/simulation', { preHandler: requireAdmin }, async () => {
    const entry = await options.store.get('settings', 'simulation');
    return simulationSettingsSchema.parse(entry?.value ?? { delayMs: 1_000 });
  });

  app.put('/api/settings/simulation', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const settings = simulationSettingsSchema.parse(request.body);
      await options.store.set('settings', 'simulation', settings);
      return settings;
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get('/api/prompts/:purpose', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const purpose = promptPurposeSchema.parse((request.params as { purpose: string }).purpose);
      const entries = await options.store.list<PromptTemplateVersion>('prompt');
      return entries.map((entry) => entry.value).filter((prompt) => prompt.purpose === purpose);
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post('/api/prompts/:purpose/drafts', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const purpose = promptPurposeSchema.parse((request.params as { purpose: string }).purpose);
      const { content } = promptDraftBodySchema.parse(request.body);
      const existing = (await options.store.list<PromptTemplateVersion>('prompt'))
        .map((entry) => entry.value)
        .filter((prompt) => prompt.purpose === purpose);
      const prompt = promptTemplateVersionSchema.parse({
        id: randomUUID(),
        purpose,
        version: Math.max(0, ...existing.map((item) => item.version)) + 1,
        status: 'draft',
        content,
        createdBy: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      await options.store.set('prompt', prompt.id, prompt);
      return await reply.code(201).send(prompt);
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post(
    '/api/prompts/:purpose/:id/publish',
    { preHandler: requireAdmin },
    async (request, reply) => {
      try {
        const params = z
          .object({ purpose: promptPurposeSchema, id: z.uuid() })
          .parse(request.params);
        const entries = await options.store.list<PromptTemplateVersion>('prompt');
        const versions = entries.map((entry) => entry.value);
        const target = versions.find(
          (prompt) => prompt.id === params.id && prompt.purpose === params.purpose,
        );
        if (!target) return await reply.code(404).send({ error: 'Prompt version not found.' });
        const now = new Date().toISOString();
        for (const prompt of versions.filter((item) => item.purpose === params.purpose)) {
          await options.store.set(
            'prompt',
            prompt.id,
            promptTemplateVersionSchema.parse({
              ...prompt,
              status:
                prompt.id === target.id
                  ? 'published'
                  : prompt.status === 'published'
                    ? 'archived'
                    : prompt.status,
              ...(prompt.id === target.id ? { publishedAt: now } : {}),
            }),
          );
        }
        return (await options.store.get<PromptTemplateVersion>('prompt', target.id))!.value;
      } catch (error) {
        return await reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );

  app.get('/api/chat-sessions', { preHandler: requireAdmin }, async () => {
    const entries = await options.store.list<ChatSession>('chat-session');
    return await Promise.all(
      entries.map(async (entry) => {
        if (entry.value.status !== 'pending') return entry.value;
        const verification = await options.store.get<VerificationRecord>('verification', entry.key);
        return {
          ...entry.value,
          ...(verification?.value.expiresAt
            ? { verificationExpiresAt: verification.value.expiresAt }
            : {}),
        };
      }),
    );
  });

  app.get('/api/chat-sessions/candidates', { preHandler: requireAdmin }, async () => {
    const entries = await options.store.list<{
      candidates?: Array<{
        externalId: string;
        spaceId: string;
        displayName: string;
      }>;
    }>('session-candidates');
    const runtimes = await options.store.list<{ nodeType?: 'qq' | 'discord' }>('node-runtime');
    const nodeTypes = new Map(runtimes.map((entry) => [entry.key, entry.value.nodeType]));
    return entries.flatMap((entry) =>
      (entry.value.candidates ?? []).map((candidate) => ({
        nodeId: entry.key,
        platform: nodeTypes.get(entry.key),
        ...candidate,
      })),
    );
  });

  app.post('/api/chat-sessions', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const candidate = sessionCandidateSchema.parse(request.body);
      const nodeEntry = await options.store.get<NodeSession>('node-session', candidate.nodeId);
      if (
        !nodeEntry ||
        nodeEntry.value.revoked ||
        nodeEntry.value.nodeType !== candidate.platform
      ) {
        return await reply
          .code(400)
          .send({ error: 'Client does not exist or platform mismatches.' });
      }
      if (!gateway?.isNodeConnected(candidate.nodeId)) {
        return await reply.code(409).send({ error: 'Client is offline.' });
      }
      const discovered = await options.store.get<{
        candidates?: Array<{ externalId: string; spaceId: string; displayName: string }>;
      }>('session-candidates', candidate.nodeId);
      const match = discovered?.value.candidates?.find(
        (item) =>
          item.externalId === candidate.externalId &&
          (candidate.platform === 'qq' || item.spaceId === candidate.spaceId),
      );
      const displayName =
        candidate.displayName?.trim() ||
        match?.displayName ||
        (candidate.platform === 'qq'
          ? `QQ ${candidate.externalId}`
          : `Discord ${candidate.spaceId} / ${candidate.externalId}`);
      const now = new Date().toISOString();
      const session = chatSessionSchema.parse({
        id: randomUUID(),
        ...candidate,
        displayName,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
      await options.store.set('chat-session', session.id, session);
      return await reply.code(201).send(session);
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.patch('/api/chat-sessions/:id', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const body = sessionUpdateSchema.parse(request.body);
      const entry = await options.store.get<ChatSession>('chat-session', id);
      if (!entry) return await reply.code(404).send({ error: 'Chat session not found.' });
      const updated = chatSessionSchema.parse({
        ...entry.value,
        ...(body.remark === undefined ? {} : { remark: body.remark ?? undefined }),
        ...(body.fetchOnly === undefined ? {} : { fetchOnly: body.fetchOnly }),
        updatedAt: new Date().toISOString(),
      });
      await options.store.set('chat-session', id, updated);
      return updated;
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete('/api/chat-sessions/:id', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      if (!(await options.store.delete('chat-session', id))) {
        return await reply.code(404).send({ error: 'Chat session not found.' });
      }
      await options.store.delete('verification', id);
      return { ok: true };
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post(
    '/api/chat-sessions/:id/send-code',
    { preHandler: requireAdmin },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.uuid() }).parse(request.params);
        const sessionEntry = await options.store.get<ChatSession>('chat-session', id);
        if (!sessionEntry) return await reply.code(404).send({ error: 'Chat session not found.' });
        const previous = await options.store.get<VerificationRecord>('verification', id);
        if (previous && Date.now() - Date.parse(previous.value.sentAt) < 30_000) {
          return await reply.code(429).send({ error: 'Verification resend is rate limited.' });
        }
        if (!gateway) return await reply.code(503).send({ error: 'Node gateway is unavailable.' });
        const code = randomBytes(6).toString('base64url').toUpperCase();
        const sentAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
        await gateway.sendToNode(sessionEntry.value.nodeId, 'session.verify', {
          platform: sessionEntry.value.platform,
          externalId: sessionEntry.value.externalId,
          code,
          expiresAt,
        });
        await options.store.set('verification', id, {
          digest: verificationDigest(code, options.verificationSecret),
          expiresAt,
          sentAt,
          attemptCount: 0,
        } satisfies VerificationRecord);
        return { expiresAt };
      } catch (error) {
        return await reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );

  app.post(
    '/api/chat-sessions/:id/verify',
    { preHandler: requireAdmin },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.uuid() }).parse(request.params);
        const { code } = z.object({ code: z.string().min(1).max(128) }).parse(request.body);
        const sessionEntry = await options.store.get<ChatSession>('chat-session', id);
        const verificationEntry = await options.store.get<VerificationRecord>('verification', id);
        if (!sessionEntry || !verificationEntry) {
          return await reply.code(404).send({ error: 'Verification request not found.' });
        }
        const verification = verificationEntry.value;
        if (Date.parse(verification.expiresAt) <= Date.now()) {
          return await reply.code(400).send({ error: 'Verification code expired.' });
        }
        if (verification.attemptCount >= 5) {
          return await reply.code(423).send({ error: 'Verification is locked.' });
        }
        const actual = Buffer.from(
          verificationDigest(code.trim().toUpperCase(), options.verificationSecret),
        );
        const expected = Buffer.from(verification.digest);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          await options.store.set('verification', id, {
            ...verification,
            attemptCount: verification.attemptCount + 1,
          });
          return await reply.code(400).send({ error: 'Verification code is incorrect.' });
        }
        const now = new Date().toISOString();
        const otherSessions = await options.store.list<ChatSession>('chat-session');
        for (const other of otherSessions) {
          if (
            other.key !== id &&
            other.value.nodeId === sessionEntry.value.nodeId &&
            other.value.externalId === sessionEntry.value.externalId &&
            (other.value.status === 'verified' || other.value.status === 'pending')
          ) {
            await options.store.set(
              'chat-session',
              other.key,
              chatSessionSchema.parse({
                ...other.value,
                status: 'stale',
                updatedAt: now,
              }),
            );
          }
        }
        const verified = chatSessionSchema.parse({
          ...sessionEntry.value,
          status: 'verified',
          verifiedAt: now,
          updatedAt: now,
        });
        await options.store.set('chat-session', id, verified);
        await options.store.delete('verification', id);
        return verified;
      } catch (error) {
        return await reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );

  app.get('/api/blueprints', { preHandler: requireAdmin }, async () => {
    const blueprints = await options.store.list('blueprint');
    const versions = await options.store.list<BlueprintVersion>('blueprint-version');
    return blueprints.map((entry) => ({
      ...blueprintSchema.parse(entry.value),
      versions: versions
        .map((version) => version.value)
        .filter((version) => version.blueprintId === entry.key)
        .sort((left, right) => right.version - left.version),
    }));
  });

  app.post('/api/blueprints', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const body = blueprintDraftBodySchema.parse(request.body);
      const blueprintId = randomUUID();
      const now = new Date().toISOString();
      const version = blueprintVersionSchema.parse({
        id: randomUUID(),
        blueprintId,
        version: 1,
        status: 'draft',
        nodes: body.nodes,
        edges: body.edges,
        createdBy: randomUUID(),
        createdAt: now,
      });
      await options.store.set('blueprint', blueprintId, {
        id: blueprintId,
        name: body.name,
        enabled: false,
        createdAt: now,
        updatedAt: now,
      });
      await options.store.set('blueprint-version', `${blueprintId}:1`, version);
      return await reply.code(201).send(version);
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.patch('/api/blueprints/:id', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const id = z.uuid().parse((request.params as { id: string }).id);
      const body = blueprintUpdateBodySchema.parse(request.body);
      const existing = await options.store.get<Blueprint>('blueprint', id);
      if (!existing) return await reply.code(404).send({ error: 'Blueprint not found.' });
      const updated = blueprintSchema.parse({
        ...existing.value,
        ...body,
        updatedAt: new Date().toISOString(),
      });
      await options.store.set('blueprint', id, updated);
      return updated;
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.delete('/api/blueprints/:id', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const id = z.uuid().parse((request.params as { id: string }).id);
      const existing = await options.store.get<Blueprint>('blueprint', id);
      if (!existing) return await reply.code(404).send({ error: 'Blueprint not found.' });
      const versions = await options.store.list<BlueprintVersion>('blueprint-version');
      for (const version of versions.filter((item) => item.value.blueprintId === id)) {
        await options.store.delete('blueprint-version', version.key);
      }
      await options.store.delete('blueprint', id);
      return { ok: true };
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post('/api/blueprints/:id/versions', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const id = z.uuid().parse((request.params as { id: string }).id);
      const body = blueprintDraftBodySchema.pick({ nodes: true, edges: true }).parse(request.body);
      const blueprint = await options.store.get<Blueprint>('blueprint', id);
      if (!blueprint) return await reply.code(404).send({ error: 'Blueprint not found.' });
      const versions = (await options.store.list<BlueprintVersion>('blueprint-version')).filter(
        (item) => item.value.blueprintId === id,
      );
      const versionNumber =
        versions.reduce((maximum, item) => Math.max(maximum, item.value.version), 0) + 1;
      const version = blueprintVersionSchema.parse({
        id: randomUUID(),
        blueprintId: id,
        version: versionNumber,
        status: 'draft',
        nodes: body.nodes,
        edges: body.edges,
        createdBy: randomUUID(),
        createdAt: new Date().toISOString(),
      });
      await options.store.set('blueprint-version', `${id}:${versionNumber}`, version);
      return await reply.code(201).send(version);
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.put(
    '/api/blueprints/:id/versions/:version',
    { preHandler: requireAdmin },
    async (request, reply) => {
      try {
        const params = z
          .object({ id: z.uuid(), version: z.coerce.number().int().positive() })
          .parse(request.params);
        const existing = await options.store.get<BlueprintVersion>(
          'blueprint-version',
          `${params.id}:${params.version}`,
        );
        if (!existing) return await reply.code(404).send({ error: 'Blueprint version not found.' });
        if (existing.value.status !== 'draft') {
          return await reply.code(409).send({ error: 'Only draft versions can be edited.' });
        }
        const body = blueprintDraftBodySchema
          .pick({ nodes: true, edges: true })
          .parse(request.body);
        const updated = blueprintVersionSchema.parse({ ...existing.value, ...body });
        await options.store.set('blueprint-version', `${params.id}:${params.version}`, updated);
        return updated;
      } catch (error) {
        return await reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );

  app.post(
    '/api/blueprints/:id/versions/:version/publish',
    { preHandler: requireAdmin },
    async (request, reply) => {
      try {
        const params = z
          .object({ id: z.uuid(), version: z.coerce.number().int().positive() })
          .parse(request.params);
        const entry = await options.store.get<BlueprintVersion>(
          'blueprint-version',
          `${params.id}:${params.version}`,
        );
        if (!entry) return await reply.code(404).send({ error: 'Blueprint version not found.' });
        const sessions = (await options.store.list<ChatSession>('chat-session')).map(
          (item) => item.value,
        );
        const verified = new Set(
          sessions.filter((session) => session.status === 'verified').map((session) => session.id),
        );
        const validation = validateBlueprint(entry.value, {
          isVerifiedSession: (sessionId) => verified.has(sessionId),
        });
        if (!validation.valid) return await reply.code(400).send(validation);
        const published = blueprintVersionSchema.parse({
          ...entry.value,
          status: 'published',
          publishedAt: new Date().toISOString(),
        });
        const versions = await options.store.list<BlueprintVersion>('blueprint-version');
        for (const versionEntry of versions.filter(
          (item) => item.value.blueprintId === params.id,
        )) {
          await options.store.set(
            'blueprint-version',
            versionEntry.key,
            versionEntry.key === `${params.id}:${params.version}`
              ? published
              : versionEntry.value.status === 'published'
                ? { ...versionEntry.value, status: 'archived' }
                : versionEntry.value,
          );
        }
        const blueprint = await options.store.get<Record<string, unknown>>('blueprint', params.id);
        await options.store.set('blueprint', params.id, {
          ...blueprint?.value,
          id: params.id,
          activeVersion: params.version,
          enabled: true,
          updatedAt: new Date().toISOString(),
        });
        return { ...validation, version: published };
      } catch (error) {
        return await reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );

  app.post('/api/blueprints/simulate', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const body = z
        .object({
          blueprint: blueprintVersionSchema,
          inputSessionId: z.uuid(),
          message: messageEnvelopeSchema,
        })
        .parse(request.body);
      const sessions = (await options.store.list<ChatSession>('chat-session')).map(
        (entry) => entry.value,
      );
      return simulateBlueprint(body.blueprint, body.inputSessionId, body.message, {
        isVerifiedSession: (id) =>
          sessions.some((session) => session.id === id && session.status === 'verified'),
      });
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post(
    '/api/blueprints/:id/simulated-input/:nodeId',
    { preHandler: requireAdmin },
    async (request, reply) => {
      try {
        if (!options.onSimulatedInput) {
          return await reply.code(503).send({ error: '模拟输入处理器尚未就绪。' });
        }
        const params = z.object({ id: z.uuid(), nodeId: z.uuid() }).parse(request.params);
        const body = z.object({ text: z.string().trim().min(1).max(20_000) }).parse(request.body);
        return await options.onSimulatedInput(params.id, params.nodeId, body.text);
      } catch (error) {
        return await reply.code(400).send({ error: errorMessage(error) });
      }
    },
  );

  app.get('/api/blueprints/:id/activity', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const { cursor, waitMs } = z
        .object({
          cursor: z.string().max(128).optional(),
          waitMs: z.coerce.number().int().min(0).max(30_000).default(0),
        })
        .parse(request.query);
      const readItems = async () =>
        (await options.store.list<Record<string, unknown>>('blueprint-activity'))
          .map((entry) => entry.value)
          .filter((item) => item.blueprintId === id)
          .sort((left, right) => activityCursor(left).localeCompare(activityCursor(right)))
          .filter((item) => !cursor || activityCursor(item) > cursor)
          .slice(-200);
      const deadline = Date.now() + (cursor ? waitMs : 0);
      let items = await readItems();
      while (!items.length && cursor && waitMs > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        items = await readItems();
      }
      const nextCursor = items.length
        ? activityCursor(items.at(-1)!)
        : cursor || `${String(Date.now() * 1_000).padStart(16, '0')}|`;
      const orderedItems = [...items].sort(
        (left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0),
      );
      return { items: orderedItems, cursor: nextCursor };
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get('/api/reviews', { preHandler: requireAdmin }, async () =>
    (await options.store.list('moderation-review')).map((entry) => entry.value),
  );
  app.delete('/api/reviews', { preHandler: requireAdmin }, async () => {
    const entries = await options.store.list('moderation-review');
    await Promise.all(entries.map((entry) => options.store.delete('moderation-review', entry.key)));
    return { ok: true, deleted: entries.length };
  });
  app.post('/api/reviews/:id/decision', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const { decision } = z
        .object({ decision: z.enum(['approve', 'reject']) })
        .parse(request.body);
      if (!options.onReviewAction) {
        return await reply.code(503).send({ error: 'Review handler is unavailable.' });
      }
      await options.onReviewAction(id, decision);
      return { ok: true };
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.get('/api/node-logs', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const query = z
        .object({
          nodeId: z.uuid(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(10).max(200).default(50),
          level: z.enum(['all', 'warn', 'error']).default('all'),
          search: z.string().trim().max(200).default(''),
        })
        .parse(request.query);
      const node = await options.store.get<NodeSession>('node-session', query.nodeId);
      if (!node || node.value.revoked) {
        return await reply.code(404).send({ error: '客户端不存在或已撤销。' });
      }
      if (!gateway?.isNodeConnected(query.nodeId)) {
        return await reply.code(409).send({ error: '客户端当前离线，无法拉取日志。' });
      }
      const requestId = randomUUID();
      const pagePromise = new Promise<z.infer<typeof nodeLogPageSchema>>((resolvePage, reject) => {
        const timer = setTimeout(() => {
          pendingNodeLogRequests.delete(requestId);
          reject(new Error('客户端日志响应超时。'));
        }, 15_000);
        timer.unref();
        pendingNodeLogRequests.set(requestId, {
          resolve: resolvePage,
          reject,
          timer,
        });
      });
      try {
        await gateway.sendToNode(query.nodeId, 'node.logs.request', {
          requestId,
          page: query.page,
          pageSize: query.pageSize,
          level: query.level,
          search: query.search,
        });
        return await pagePromise;
      } finally {
        const pending = pendingNodeLogRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingNodeLogRequests.delete(requestId);
        }
      }
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });
  app.get('/api/logs', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(10).max(200).default(50),
          level: z.enum(['all', 'debug', 'info', 'warn', 'error']).default('all'),
          search: z.string().trim().max(200).default(''),
        })
        .parse(request.query);
      let records = (await options.store.list<Record<string, unknown>>('trace-log'))
        .map((entry) => entry.value)
        .sort((left, right) =>
          String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')),
        );
      if (query.level !== 'all') {
        records = records.filter((record) => String(record.level ?? 'info') === query.level);
      }
      if (query.search) {
        const needle = query.search.toLocaleLowerCase();
        records = records.filter((record) =>
          JSON.stringify(record).toLocaleLowerCase().includes(needle),
        );
      }
      const total = records.length;
      const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
      const page = Math.min(query.page, totalPages);
      return {
        items: records.slice((page - 1) * query.pageSize, page * query.pageSize),
        page,
        pageSize: query.pageSize,
        total,
        totalPages,
      };
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
  });

  const staticRoot = options.staticRoot ?? resolve(process.cwd(), 'apps', 'central-web', 'dist');
  if (existsSync(staticRoot)) {
    void app.register(fastifyStatic, {
      root: staticRoot,
      wildcard: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return await reply.code(404).send({ error: 'API route not found.' });
      }
      return await reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    for (const [requestId, pending] of pendingNodeLogRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('中央服务正在关闭。'));
      pendingNodeLogRequests.delete(requestId);
    }
    if (gateway) await gateway.close();
  });

  return { app, auth, getGateway: () => gateway };
}

function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie('disqord_session', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: 12 * 60 * 60,
  });
}

function verificationDigest(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code).digest('hex');
}

function activityCursor(activity: Record<string, unknown>): string {
  const sequence =
    typeof activity.sequence === 'number'
      ? activity.sequence
      : Date.parse(String(activity.createdAt ?? '')) * 1_000;
  return `${String(Number.isFinite(sequence) ? sequence : 0).padStart(16, '0')}|${String(activity.id ?? '')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed.';
}
