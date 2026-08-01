import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DiscordBotAdapter } from '@disqord/adapter-discord';
import {
  NodeBridgeRuntime,
  NodeControlServer,
  type PlatformAdapter,
  type PlatformSessionCandidate,
} from '@disqord/node-runtime';
import { createProgramDescriptor, type MessageEnvelope } from '@disqord/shared';
import { z } from 'zod';

export const program = createProgramDescriptor('discord-node');

const envSchema = z.object({
  CENTRAL_WSS_URL: z.url(),
  NODE_CONFIG_PATH: z.string().min(1).default('./data/discord-node.json'),
  NODE_QUEUE_PATH: z.string().min(1).default('./data/discord-queue.json'),
  NODE_LOG_PATH: z.string().min(1).default('./logs/discord-node.jsonl'),
  ALLOW_INSECURE_CENTRAL: z.enum(['true', 'false']).default('false'),
  DISCORD_BOT_TOKEN: z.string().min(1),
  NODE_WEB_HOST: z.string().default('127.0.0.1'),
  NODE_WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(8090),
  NODE_WEB_TOKEN: z.string().min(16).optional(),
  NODE_WEB_ROOT: z.string().min(1).default('./apps/node-web/dist'),
});

class DiscordPlatformAdapter implements PlatformAdapter {
  readonly #dispatch: {
    handler?: (message: MessageEnvelope) => void | Promise<void>;
  } = {};
  readonly #client: DiscordBotAdapter;

  constructor(nodeId: string, token: string) {
    this.#client = new DiscordBotAdapter({
      nodeId,
      token,
      onMessage: async (message) => await this.#dispatch.handler?.(message),
    });
  }

  async start(onMessage: (message: MessageEnvelope) => void | Promise<void>): Promise<void> {
    this.#dispatch.handler = onMessage;
    await this.#client.start();
  }

  async stop(): Promise<void> {
    await this.#client.stop();
  }

  async listSessions(): Promise<readonly PlatformSessionCandidate[]> {
    return (await this.#client.listChannels()).map((channel) => ({
      externalId: channel.id,
      spaceId: channel.guildId,
      displayName: `${channel.guildName} / #${channel.name}`,
    }));
  }

  async sendVerification(externalId: string, code: string, expiresAt: string): Promise<string> {
    return await this.#client.sendVerificationCode(externalId, code, expiresAt);
  }

  async sendCard(externalId: string, png: Uint8Array, replyMessageId?: string): Promise<string> {
    return await this.#client.sendRenderedCard(externalId, png, replyMessageId);
  }
}

export async function startDiscordNode(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const env = envSchema.parse(environment);
  const startedAt = new Date().toISOString();
  let runtimeState: 'starting' | 'connected' | 'retrying' | 'stopped' = 'starting';
  let runtimeDetail: string | undefined;
  let platformConnected = false;
  const runtime = new NodeBridgeRuntime({
    nodeType: 'discord',
    centralUrl: env.CENTRAL_WSS_URL,
    configPath: resolve(env.NODE_CONFIG_PATH),
    queuePath: resolve(env.NODE_QUEUE_PATH),
    logPath: resolve(env.NODE_LOG_PATH),
    allowInsecureCentral: env.ALLOW_INSECURE_CENTRAL === 'true',
    createAdapter: (identity) => new DiscordPlatformAdapter(identity.nodeId, env.DISCORD_BOT_TOKEN),
    onStatus: ({ state, detail }) => {
      runtimeState = state;
      runtimeDetail = detail;
      console.info(`[DisQord/Discord] ${state}${detail ? `: ${detail}` : ''}`);
    },
  });
  const control = new NodeControlServer({
    host: env.NODE_WEB_HOST,
    port: env.NODE_WEB_PORT,
    staticRoot: resolve(env.NODE_WEB_ROOT),
    ...(env.NODE_WEB_TOKEN ? { adminToken: env.NODE_WEB_TOKEN } : {}),
    getStatus: () => ({
      program: 'discord-node',
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
    console.error(`[DisQord/Discord] ${runtimeDetail}`);
  }
  const shutdown = () =>
    void Promise.all([runtime.stop(), control.close()]).finally(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void startDiscordNode().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
