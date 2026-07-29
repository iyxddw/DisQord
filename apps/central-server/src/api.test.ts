import { describe, expect, it } from 'vitest';

import { PairingAuthority } from '@disqord/transport';

import { createCentralApplication } from './api.js';
import { InMemorySecretStore, InMemoryStateStore } from './state-store.js';

function createTestApplication() {
  return createCentralApplication({
    store: new InMemoryStateStore(),
    secrets: new InMemorySecretStore(),
    pairingAuthority: new PairingAuthority(
      'api-test-pairing-pepper-that-is-longer-than-32-characters',
    ),
    verificationSecret: 'api-test-verification-secret-longer-than-32-characters',
    secureCookies: false,
  });
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
});
