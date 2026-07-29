import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AuthenticatedNodeClient,
  CentralNodeGateway,
  generateNodeIdentity,
  PairingAuthority,
  type ReceivedNodeFrame,
} from './index.js';

const resources: Array<{
  client?: AuthenticatedNodeClient;
  gateway: CentralNodeGateway;
  server: Server;
}> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.client?.disconnect();
    await resource.gateway.close();
    resource.server.close();
  }
});

async function startGateway(onFrame: (frame: ReceivedNodeFrame) => void | Promise<void>) {
  const server = createServer();
  const authority = new PairingAuthority('gateway-test-pepper-that-is-longer-than-32-characters');
  const gateway = new CentralNodeGateway({
    server,
    pairingAuthority: authority,
    heartbeatIntervalMs: 50,
    connectionTimeoutMs: 500,
    onFrame,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test gateway did not bind a TCP port.');
  }
  return {
    authority,
    gateway,
    server,
    url: `ws://127.0.0.1:${address.port}/node`,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('central node WebSocket gateway', () => {
  it('pairs, authenticates, acknowledges and reconnects a platform node', async () => {
    const received: ReceivedNodeFrame[] = [];
    const running = await startGateway((frame) => received.push(frame));
    const identity = generateNodeIdentity('qq');
    const pairingCode = running.authority.createCode('qq');
    const token = await AuthenticatedNodeClient.pair({
      url: running.url,
      identity,
      pairingCode: pairingCode.code,
      allowInsecure: true,
    });
    let connectionCount = 0;
    const commands: Array<{ kind: string; payload: unknown }> = [];
    const client = new AuthenticatedNodeClient({
      url: running.url,
      identity,
      sessionToken: token,
      allowInsecure: true,
      reconnectBaseDelayMs: 20,
      reconnectMaxDelayMs: 50,
      acknowledgementTimeoutMs: 1_000,
      onConnected: () => {
        connectionCount += 1;
      },
      onCommand: async (command) => {
        commands.push({ kind: command.kind, payload: command.payload });
      },
    });
    resources.push({ ...running, client });

    await client.connect();
    await client.send('message.upload', { messageId: 'qq-1' });
    expect(received).toMatchObject([
      {
        nodeId: identity.nodeId,
        nodeType: 'qq',
        kind: 'message.upload',
        payload: { messageId: 'qq-1' },
      },
    ]);
    await running.gateway.sendToNode(identity.nodeId, 'message.deliver', {
      targetSessionId: 'qq-group-1',
    });
    expect(commands).toEqual([
      {
        kind: 'message.deliver',
        payload: { targetSessionId: 'qq-group-1' },
      },
    ]);

    expect(running.gateway.disconnectNode(identity.nodeId)).toBe(true);
    await waitFor(() => connectionCount >= 2);
    await client.send('message.upload', { messageId: 'qq-2' });
    expect(received).toHaveLength(2);
  });

  it('refuses plaintext WebSocket URLs unless explicitly allowed for local testing', async () => {
    const identity = generateNodeIdentity('discord');

    expect(
      () =>
        new AuthenticatedNodeClient({
          url: 'ws://example.test/node',
          identity,
          sessionToken: 'x'.repeat(32),
        }),
    ).toThrow('wss://');
  });
});
