import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PairingAuthority } from '@disqord/transport';

import { createCentralApplication } from './api.js';
import { InMemorySecretStore, InMemoryStateStore } from './state-store.js';

function createTestApplication() {
  const store = new InMemoryStateStore();
  return {
    ...createCentralApplication({
      store,
      secrets: new InMemorySecretStore(),
      pairingAuthority: new PairingAuthority(
        'api-test-pairing-pepper-that-is-longer-than-32-characters',
      ),
      verificationSecret: 'api-test-verification-secret-longer-than-32-characters',
      secureCookies: false,
    }),
    store,
  };
}

async function configureAdministrator(
  central: ReturnType<typeof createTestApplication>,
): Promise<string> {
  const response = await central.app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: 'a-strong-test-password' },
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.find((cookie) => cookie.name === 'disqord_session')!.value;
}

describe('central control-plane API', () => {
  it('requires setup and authenticates control-plane mutations', async () => {
    const central = createTestApplication();
    const initialStatus = await central.app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(initialStatus.json()).toMatchObject({
      configured: false,
      authenticated: false,
      onboardingComplete: false,
    });
    const unauthorized = await central.app.inject({
      method: 'POST',
      url: '/api/chat-sessions',
      payload: {},
    });
    expect(unauthorized.statusCode).toBe(401);

    const token = await configureAdministrator(central);
    const setupStatus = await central.app.inject({
      method: 'GET',
      url: '/api/auth/status',
      cookies: { disqord_session: token },
    });
    expect(setupStatus.json()).toMatchObject({
      configured: true,
      authenticated: true,
      onboardingComplete: false,
    });
    const complete = await central.app.inject({
      method: 'POST',
      url: '/api/setup/complete',
      cookies: { disqord_session: token },
    });
    expect(complete.statusCode).toBe(200);
    const completedStatus = await central.app.inject({
      method: 'GET',
      url: '/api/auth/status',
      cookies: { disqord_session: token },
    });
    expect(completedStatus.json()).toMatchObject({ onboardingComplete: true });
    const nodes = await central.app.inject({
      method: 'GET',
      url: '/api/nodes',
      cookies: { disqord_session: token },
    });
    expect(nodes.statusCode).toBe(200);
    expect(nodes.json()).toEqual([]);
    await central.app.close();
  });

  it('never returns the configured LLM API key', async () => {
    const central = createTestApplication();
    const token = await configureAdministrator(central);
    const update = await central.app.inject({
      method: 'PUT',
      url: '/api/settings/llm',
      cookies: { disqord_session: token },
      payload: {
        baseUrl: 'https://llm.example.test/v1',
        apiKey: 'top-secret-api-key',
        translationModel: 'translate',
        moderationModel: 'moderate',
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.body).not.toContain('top-secret-api-key');

    const read = await central.app.inject({
      method: 'GET',
      url: '/api/settings/llm',
      cookies: { disqord_session: token },
    });
    expect(read.json()).toMatchObject({
      providers: [
        {
          baseUrl: 'https://llm.example.test/v1',
          apiKeyConfigured: true,
        },
      ],
    });
    expect(read.body).not.toContain('top-secret-api-key');
    await central.app.close();
  });

  it('persists the delayed-message threshold used by log filtering', async () => {
    const central = createTestApplication();
    const token = await configureAdministrator(central);
    const initial = await central.app.inject({
      method: 'GET',
      url: '/api/settings/logs',
      cookies: { disqord_session: token },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ delayedMessageThresholdMs: 2_000 });

    const update = await central.app.inject({
      method: 'PUT',
      url: '/api/settings/logs',
      cookies: { disqord_session: token },
      payload: { delayedMessageThresholdMs: 3_500 },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toEqual({ delayedMessageThresholdMs: 3_500 });

    const read = await central.app.inject({
      method: 'GET',
      url: '/api/settings/logs',
      cookies: { disqord_session: token },
    });
    expect(read.json()).toEqual({ delayedMessageThresholdMs: 3_500 });
    await central.app.close();
  });

  it('persists client instance names and lists every instance separately', async () => {
    const central = createTestApplication();
    const token = await configureAdministrator(central);
    const firstNodeId = randomUUID();
    const secondNodeId = randomUUID();
    await central.store.set('node-session', firstNodeId, {
      nodeId: firstNodeId,
      nodeType: 'qq',
      revoked: false,
    });
    await central.store.set('node-session', secondNodeId, {
      nodeId: secondNodeId,
      nodeType: 'qq',
      revoked: false,
    });

    const renamed = await central.app.inject({
      method: 'PATCH',
      url: `/api/nodes/${secondNodeId}`,
      cookies: { disqord_session: token },
      payload: { name: '备用 QQ' },
    });
    expect(renamed.statusCode).toBe(200);

    const nodes = await central.app.inject({
      method: 'GET',
      url: '/api/nodes',
      cookies: { disqord_session: token },
    });
    expect(nodes.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: firstNodeId, nodeType: 'qq' }),
        expect.objectContaining({ nodeId: secondNodeId, nodeType: 'qq', name: '备用 QQ' }),
      ]),
    );
    await central.app.close();
  });

  it('reports only non-self messages in overview activity', async () => {
    const central = createTestApplication();
    const token = await configureAdministrator(central);
    const nodeId = randomUUID();
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    await central.store.set('chat-session', sessionId, {
      id: sessionId,
      nodeId,
      platform: 'qq',
      externalId: '123456',
      spaceId: '123456',
      displayName: '测试群',
      status: 'verified',
      createdAt: now,
      updatedAt: now,
    });
    const message = (fromSelf: boolean, messageId: string) => ({
      schemaVersion: 1 as const,
      eventId: randomUUID(),
      source: {
        nodeId,
        platform: 'qq' as const,
        spaceId: '123456',
        channelId: '123456',
        messageId,
      },
      sender: { id: fromSelf ? 'bot' : 'person-1', displayName: fromSelf ? '机器人' : '用户' },
      sentAt: now,
      fromSelf,
      kind: 'text' as const,
      text: '测试消息',
      attachments: [],
      traceId: randomUUID(),
    });
    await central.store.set('message-history', randomUUID(), {
      sessionId,
      message: message(false, 'message-1'),
    });
    await central.store.set('message-history', randomUUID(), {
      sessionId,
      message: message(false, 'message-2'),
    });
    await central.store.set('message-history', randomUUID(), {
      sessionId,
      message: message(true, 'message-self'),
    });

    const response = await central.app.inject({
      method: 'GET',
      url: '/api/overview/activity?range=24h&offsetMinutes=480',
      cookies: { disqord_session: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      totalMessages: 2,
      activeSenders: 1,
      topSessions: [
        expect.objectContaining({
          sessionId,
          name: '测试群',
          messages: 2,
          activeSenders: 1,
        }),
      ],
    });
    expect(
      response
        .json<{ buckets: Array<{ qqMessages: number }> }>()
        .buckets.reduce((total, bucket) => total + bucket.qqMessages, 0),
    ).toBe(2);
    await central.app.close();
  });

  it('lists, versions, disables, and deletes saved blueprints', async () => {
    const central = createTestApplication();
    const token = await configureAdministrator(central);
    const created = await central.app.inject({
      method: 'POST',
      url: '/api/blueprints',
      cookies: { disqord_session: token },
      payload: { name: '双向转发', nodes: [], edges: [] },
    });
    expect(created.statusCode).toBe(201);
    const firstVersion = created.json<{ blueprintId: string; version: number }>();

    const second = await central.app.inject({
      method: 'POST',
      url: `/api/blueprints/${firstVersion.blueprintId}/versions`,
      cookies: { disqord_session: token },
      payload: { nodes: [], edges: [] },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ blueprintId: firstVersion.blueprintId, version: 2 });

    const enabled = await central.app.inject({
      method: 'PATCH',
      url: `/api/blueprints/${firstVersion.blueprintId}`,
      cookies: { disqord_session: token },
      payload: { enabled: true, name: '已编辑蓝图' },
    });
    expect(enabled.json()).toMatchObject({ name: '已编辑蓝图', enabled: true });

    const listed = await central.app.inject({
      method: 'GET',
      url: '/api/blueprints',
      cookies: { disqord_session: token },
    });
    expect(listed.json()).toEqual([
      expect.objectContaining({
        id: firstVersion.blueprintId,
        name: '已编辑蓝图',
        enabled: true,
        versions: [
          expect.objectContaining({ version: 2 }),
          expect.objectContaining({ version: 1 }),
        ],
      }),
    ]);

    const removed = await central.app.inject({
      method: 'DELETE',
      url: `/api/blueprints/${firstVersion.blueprintId}`,
      cookies: { disqord_session: token },
    });
    expect(removed.statusCode).toBe(200);
    const empty = await central.app.inject({
      method: 'GET',
      url: '/api/blueprints',
      cookies: { disqord_session: token },
    });
    expect(empty.json()).toEqual([]);
    await central.app.close();
  });

  it('updates remarks and deletes chat sessions', async () => {
    const central = createTestApplication();
    const token = await configureAdministrator(central);
    const now = new Date().toISOString();
    const id = randomUUID();
    await central.store.set('chat-session', id, {
      id,
      nodeId: randomUUID(),
      platform: 'qq',
      externalId: '123456',
      spaceId: '123456',
      displayName: 'QQ 测试群',
      status: 'verified',
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const updated = await central.app.inject({
      method: 'PATCH',
      url: `/api/chat-sessions/${id}`,
      cookies: { disqord_session: token },
      payload: { remark: '工作群' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ remark: '工作群' });

    const fetchOnly = await central.app.inject({
      method: 'PATCH',
      url: `/api/chat-sessions/${id}`,
      cookies: { disqord_session: token },
      payload: { fetchOnly: true },
    });
    expect(fetchOnly.statusCode).toBe(200);
    expect(fetchOnly.json()).toMatchObject({ fetchOnly: true });

    const unchanged = await central.app.inject({
      method: 'PATCH',
      url: `/api/chat-sessions/${id}`,
      cookies: { disqord_session: token },
      payload: {},
    });
    expect(unchanged.statusCode).toBe(400);

    const removed = await central.app.inject({
      method: 'DELETE',
      url: `/api/chat-sessions/${id}`,
      cookies: { disqord_session: token },
    });
    expect(removed.statusCode).toBe(200);
    expect(await central.store.get('chat-session', id)).toBeUndefined();
    await central.app.close();
  });

  it('clears all manual review records', async () => {
    const central = createTestApplication();
    const token = await configureAdministrator(central);
    await central.store.set('moderation-review', randomUUID(), { status: 'pending' });
    await central.store.set('moderation-review', randomUUID(), { status: 'approved' });

    const response = await central.app.inject({
      method: 'DELETE',
      url: '/api/reviews',
      cookies: { disqord_session: token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deleted: 2 });
    expect(await central.store.list('moderation-review')).toEqual([]);
    await central.app.close();
  });

  it('filters and paginates trace logs', async () => {
    const central = createTestApplication();
    const token = await configureAdministrator(central);
    for (let index = 0; index < 12; index += 1) {
      await central.store.set('trace-log', randomUUID(), {
        traceId: `trace-${index}`,
        level: index % 2 === 0 ? 'info' : 'debug',
        event: index % 2 === 0 ? 'message_received' : 'node_debug',
        details: { index },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      });
    }

    const firstPage = await central.app.inject({
      method: 'GET',
      url: '/api/logs?page=1&pageSize=10&level=info&search=message_received',
      cookies: { disqord_session: token },
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({
      page: 1,
      pageSize: 10,
      total: 6,
      totalPages: 1,
      items: expect.arrayContaining([
        expect.objectContaining({ event: 'message_received', level: 'info' }),
      ]),
    });

    for (const [index, level] of ['info', 'warn', 'info'].entries()) {
      await central.store.set('trace-log', randomUUID(), {
        id: randomUUID(),
        traceId: 'trace-grouped',
        level,
        event: index === 1 ? 'delivery_retry_scheduled' : `grouped_step_${index}`,
        details: { index },
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
      });
    }
    const groupedPage = await central.app.inject({
      method: 'GET',
      url: '/api/logs?page=1&pageSize=10&view=traces&traceFilter=retry&search=trace-grouped',
      cookies: { disqord_session: token },
    });
    expect(groupedPage.statusCode).toBe(200);
    expect(groupedPage.json()).toMatchObject({
      total: 1,
      items: [
        {
          traceId: 'trace-grouped',
          level: 'warn',
          event: 'delivery_retry_scheduled',
          durationMs: 2_000,
          eventCount: 3,
          events: expect.arrayContaining([
            expect.objectContaining({ event: 'delivery_retry_scheduled' }),
          ]),
        },
      ],
    });
    await central.app.close();
  });
});
