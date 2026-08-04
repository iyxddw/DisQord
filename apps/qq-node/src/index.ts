import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NapCatOneBotClient } from '@disqord/adapter-napcat';
import {
  NodeBridgeRuntime,
  NodeControlServer,
  type PlatformAdapter,
  type PlatformSessionCandidate,
} from '@disqord/node-runtime';
import { createProgramDescriptor, type MessageEnvelope } from '@disqord/shared';
import { z } from 'zod';

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[DisQord/QQ] unhandled rejection', reason);
});
process.on('uncaughtException', (error: unknown) => {
  console.error('[DisQord/QQ] uncaught exception', error);
  process.exitCode = 1;
});

export const program = createProgramDescriptor('qq-node');

const envSchema = z.object({
  CENTRAL_WSS_URL: z.url(),
  NODE_CONFIG_PATH: z.string().min(1).default('./data/qq-node.json'),
  NODE_QUEUE_PATH: z.string().min(1).default('./data/qq-queue.json'),
  NODE_LOG_PATH: z.string().min(1).default('./logs/qq-node.jsonl'),
  ALLOW_INSECURE_CENTRAL: z.enum(['true', 'false']).default('false'),
  NAPCAT_ONEBOT_WS_URL: z.url(),
  NAPCAT_ACCESS_TOKEN: z.string().optional(),
  NODE_WEB_HOST: z.string().default('127.0.0.1'),
  NODE_WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(8090),
  NODE_WEB_TOKEN: z.string().min(16).optional(),
  NODE_WEB_ROOT: z.string().min(1).default('./apps/node-web/dist'),
});

class QqPlatformAdapter implements PlatformAdapter {
  readonly #client: NapCatOneBotClient;

  constructor(nodeId: string, url: string, accessToken: string | undefined) {
    this.#client = new NapCatOneBotClient({
      url,
      nodeId,
      ...(accessToken ? { accessToken } : {}),
      onMessage: async (message) => await this.#dispatch.handler?.(message),
    });
  }

  async start(onMessage: (message: MessageEnvelope) => void | Promise<void>): Promise<void> {
    this.#dispatch.handler = onMessage;
    await this.#client.connect();
  }

  async stop(): Promise<void> {
    this.#client.disconnect();
  }

  async listSessions(): Promise<readonly PlatformSessionCandidate[]> {
    return (await this.#client.listGroups()).map((group) => ({
      externalId: group.id,
      spaceId: group.id,
      displayName: group.name,
    }));
  }

  async sendVerification(externalId: string, code: string, expiresAt: string): Promise<string> {
    return await this.#client.sendGroupText(
      externalId,
      `DisQord 会话验证码：${code}\n有效期至：${expiresAt}`,
    );
  }

  async sendCard(externalId: string, png: Uint8Array, replyMessageId?: string): Promise<string> {
    return await this.#client.sendGroupImage(externalId, png, replyMessageId);
  }

  async sendText(externalId: string, text: string, replyMessageId?: string): Promise<string> {
    return await this.#client.sendGroupText(externalId, text, replyMessageId);
  }

  readonly #dispatch: { handler?: (message: MessageEnvelope) => void | Promise<void> } = {};
}

export async function startQqNode(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const env = envSchema.parse(environment);
  const startedAt = new Date().toISOString();
  let runtimeState: 'starting' | 'connected' | 'retrying' | 'stopped' = 'starting';
  let runtimeDetail: string | undefined;
  let platformConnected = false;
  const runtime = new NodeBridgeRuntime({
    nodeType: 'qq',
    centralUrl: env.CENTRAL_WSS_URL,
    configPath: resolve(env.NODE_CONFIG_PATH),
    queuePath: resolve(env.NODE_QUEUE_PATH),
    logPath: resolve(env.NODE_LOG_PATH),
    allowInsecureCentral: env.ALLOW_INSECURE_CENTRAL === 'true',
    createAdapter: (identity) => {
      return new QqPlatformAdapter(
        identity.nodeId,
        env.NAPCAT_ONEBOT_WS_URL,
        env.NAPCAT_ACCESS_TOKEN,
      );
    },
    onStatus: ({ state, detail }) => {
      runtimeState = state;
      runtimeDetail = detail;
      console.info(`[DisQord/QQ] ${state}${detail ? `: ${detail}` : ''}`);
    },
  });
  const control = new NodeControlServer({
    host: env.NODE_WEB_HOST,
    port: env.NODE_WEB_PORT,
    staticRoot: resolve(env.NODE_WEB_ROOT),
    ...(env.NODE_WEB_TOKEN ? { adminToken: env.NODE_WEB_TOKEN } : {}),
    getStatus: () => ({
      program: 'qq-node',
      state: runtimeState,
      ...(runtimeDetail ? { detail: runtimeDetail } : {}),
      centralUrl: env.CENTRAL_WSS_URL,
      platformConnected,
      startedAt,
      logPath: resolve(env.NODE_LOG_PATH),
    }),
    refreshSessions: async () => await runtime.refreshSessions(),
    getLogs: (query) => runtime.listLogs(query),
  });
  await control.listen();
  try {
    await runtime.start();
    platformConnected = true;
  } catch (error) {
    runtimeState = 'retrying';
    runtimeDetail = error instanceof Error ? error.message : '节点启动失败。';
    console.error(`[DisQord/QQ] ${runtimeDetail}`);
  }
  const shutdown = () =>
    void Promise.all([runtime.stop(), control.close()]).finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void startQqNode().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
