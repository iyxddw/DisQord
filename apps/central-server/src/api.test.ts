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
      url: '/api/nodes/pairing-code',
      payload: { nodeType: 'qq' },
    });
    expect(unauthorized.statusCode).toBe(401);

    const token = await configureAdministrator(central);
    const paired = await central.app.inject({
      method: 'POST',
      url: '/api/nodes/pairing-code',
      cookies: { disqord_session: token },
      payload: { nodeType: 'qq' },
    });
    expect(paired.statusCode).toBe(200);
    expect(paired.json()).toMatchObject({ nodeType: 'qq' });
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
});
