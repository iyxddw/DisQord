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
    const unauthorized = await central.app.inject({
      method: 'POST',
      url: '/api/chat-sessions',
      payload: {},
    });
    expect(unauthorized.statusCode).toBe(401);

    const token = await configureAdministrator(central);
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
      baseUrl: 'https://llm.example.test/v1',
      apiKeyConfigured: true,
    });
    expect(read.body).not.toContain('top-secret-api-key');
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
    await central.app.close();
  });
});
