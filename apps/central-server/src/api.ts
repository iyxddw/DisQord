import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { simulateBlueprint, validateBlueprint } from '@disqord/blueprint';
import {
  blueprintVersionSchema,
  chatSessionSchema,
  messageEnvelopeSchema,
  promptPurposeSchema,
  promptTemplateVersionSchema,
  type BlueprintVersion,
  type ChatSession,
  type PromptTemplateVersion,
} from '@disqord/shared';
import { CentralNodeGateway, PairingAuthority, type ReceivedNodeFrame } from '@disqord/transport';
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
  displayName: z.string().min(1).max(256),
});
const llmSettingsInputSchema = z.object({
  baseUrl: z.url(),
  apiKey: z.string().min(1).max(10_000).optional(),
  translationModel: z.string().min(1).max(256),
  moderationModel: z.string().min(1).max(256),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  maxRetries: z.number().int().min(0).max(5).default(2),
  concurrency: z.number().int().min(1).max(100).default(4),
  moderationSupportsVision: z.boolean().default(false),
});
const promptDraftBodySchema = z.object({ content: z.string().min(1).max(50_000) });
const blueprintDraftBodySchema = z.object({
  name: z.string().min(1).max(256),
  nodes: blueprintVersionSchema.shape.nodes,
  edges: blueprintVersionSchema.shape.edges,
});

interface VerificationRecord {
  readonly digest: string;
  readonly expiresAt: string;
  readonly sentAt: string;
  readonly attemptCount: number;
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
          pairedAt: new Date().toISOString(),
        });
      },
      onFrame: async (frame) => {
        await options.store.set('node-runtime', frame.nodeId, {
          nodeId: frame.nodeId,
          nodeType: frame.nodeType,
          lastFrameKind: frame.kind,
          lastSeenAt: new Date().toISOString(),
        });
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
      online:
        typeof node.nodeId === 'string' ? (gateway?.isNodeConnected(node.nodeId) ?? false) : false,
    }));
  });

  app.post('/api/nodes/pairing-code', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const { nodeType } = z.object({ nodeType: z.enum(['qq', 'discord']) }).parse(request.body);
      return options.pairingAuthority.createCode(nodeType);
    } catch (error) {
      return await reply.code(400).send({ error: errorMessage(error) });
    }
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
    return {
      ...(entry?.value as Record<string, unknown> | undefined),
      apiKeyConfigured: await options.secrets.has('llm-api-key'),
    };
  });

  app.put('/api/settings/llm', { preHandler: requireAdmin }, async (request, reply) => {
    try {
      const input = llmSettingsInputSchema.parse(request.body);
      const { apiKey, ...settings } = input;
      if (apiKey) await options.secrets.set('llm-api-key', apiKey);
      await options.store.set('settings', 'llm', settings);
      return { ...settings, apiKeyConfigured: await options.secrets.has('llm-api-key') };
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

  app.get('/api/chat-sessions', { preHandler: requireAdmin }, async () =>
    (await options.store.list<ChatSession>('chat-session')).map((entry) => entry.value),
  );

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
      const now = new Date().toISOString();
      const session = chatSessionSchema.parse({
        id: randomUUID(),
        ...candidate,
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
      ...(entry.value as Record<string, unknown>),
      versions: versions
        .map((version) => version.value)
        .filter((version) => version.blueprintId === entry.key),
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

  app.get('/api/reviews', { preHandler: requireAdmin }, async () =>
    (await options.store.list('moderation-review')).map((entry) => entry.value),
  );
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
  app.get('/api/logs', { preHandler: requireAdmin }, async () =>
    (await options.store.list('trace-log')).map((entry) => entry.value),
  );

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed.';
}
