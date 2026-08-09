import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DiscordBotAdapter } from '@disqord/adapter-discord';
import {
  NodeBridgeRuntime,
  NodeControlServer,
  NodeSetupStore,
  type PlatformAdapter,
  type PlatformSessionCandidate,
} from '@disqord/node-runtime';
import { createProgramDescriptor, type MessageEnvelope } from '@disqord/shared';
import { z } from 'zod';

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[DisQord/Discord] unhandled rejection', reason);
});
process.on('uncaughtException', (error: unknown) => {
  console.error('[DisQord/Discord] uncaught exception', error);
  process.exitCode = 1;
});

export const program = createProgramDescriptor('discord-node');
const defaultEmojiDirectory = fileURLToPath(new URL('../default-emojis', import.meta.url));

const envSchema = z.object({
  CENTRAL_WSS_URL: z.url(),
  NODE_CONFIG_PATH: z.string().min(1).default('./data/discord-node.json'),
  NODE_QUEUE_PATH: z.string().min(1).default('./data/discord-queue.json'),
  NODE_LOG_PATH: z.string().min(1).default('./logs/discord-node.jsonl'),
  ALLOW_INSECURE_CENTRAL: z.enum(['true', 'false']).default('false'),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_DEFAULT_EMOJI_DIR: z.string().min(1).default(defaultEmojiDirectory),
  NODE_WEB_HOST: z.string().default('127.0.0.1'),
  NODE_WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(8090),
  NODE_WEB_TOKEN: z.string().min(16).optional(),
  NODE_WEB_ROOT: z.string().min(1).default('./apps/node-web/dist'),
});

const bootstrapEnvSchema = envSchema
  .pick({
    DISCORD_DEFAULT_EMOJI_DIR: true,
    NODE_CONFIG_PATH: true,
    NODE_QUEUE_PATH: true,
    NODE_LOG_PATH: true,
    NODE_WEB_HOST: true,
    NODE_WEB_PORT: true,
    NODE_WEB_TOKEN: true,
    NODE_WEB_ROOT: true,
  })
  .extend({ NODE_SETUP_PATH: z.string().min(1).default('./data/discord-setup.json') });

const webSocketUrlSchema = z
  .url()
  .refine(
    (value) => ['ws:', 'wss:'].includes(new URL(value).protocol),
    '必须使用 ws:// 或 wss://。',
  );
const discordSetupSchema = z.object({
  centralUrl: webSocketUrlSchema,
  discordBotToken: z.string().min(1).max(10_000),
  allowInsecureCentral: z.boolean().default(false),
});
type DiscordSetup = z.infer<typeof discordSetupSchema>;

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

  async sendText(externalId: string, text: string, replyMessageId?: string): Promise<string> {
    return await this.#client.sendText(externalId, text, replyMessageId);
  }
}

export async function startDiscordNode(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const bootstrap = bootstrapEnvSchema.parse(environment);
  const setupStore = new NodeSetupStore<DiscordSetup>(resolve(bootstrap.NODE_SETUP_PATH));
  const rawPersisted = await setupStore.load();
  const persistedResult = discordSetupSchema.safeParse(rawPersisted);
  const persisted = persistedResult.success ? persistedResult.data : undefined;
  const combinedEnvironment = {
    ...environment,
    ...(environment.CENTRAL_WSS_URL || !persisted ? {} : { CENTRAL_WSS_URL: persisted.centralUrl }),
    ...(environment.DISCORD_BOT_TOKEN || !persisted
      ? {}
      : { DISCORD_BOT_TOKEN: persisted.discordBotToken }),
    ...(environment.ALLOW_INSECURE_CENTRAL || !persisted
      ? {}
      : { ALLOW_INSECURE_CENTRAL: String(persisted.allowInsecureCentral) }),
  };
  const parsedEnvironment = envSchema.safeParse(combinedEnvironment);
  const startedAt = new Date().toISOString();
  let runtimeState: 'setup' | 'starting' | 'connected' | 'retrying' | 'stopped' =
    parsedEnvironment.success ? 'starting' : 'setup';
  let runtimeDetail: string | undefined = parsedEnvironment.success
    ? undefined
    : persistedResult.success
      ? '请完成首次启动配置。'
      : rawPersisted
        ? '已保存的首次启动配置格式无效，请重新填写。'
        : '请完成首次启动配置。';
  let platformConnected = false;
  const env = parsedEnvironment.success ? parsedEnvironment.data : undefined;
  const runtime = env
    ? new NodeBridgeRuntime({
        nodeType: 'discord',
        centralUrl: env.CENTRAL_WSS_URL,
        configPath: resolve(env.NODE_CONFIG_PATH),
        queuePath: resolve(env.NODE_QUEUE_PATH),
        logPath: resolve(env.NODE_LOG_PATH),
        inlineEmojiDirectory: resolve(env.DISCORD_DEFAULT_EMOJI_DIR),
        allowInsecureCentral: env.ALLOW_INSECURE_CENTRAL === 'true',
        createAdapter: (identity) =>
          new DiscordPlatformAdapter(identity.nodeId, env.DISCORD_BOT_TOKEN),
        onStatus: ({ state, detail }) => {
          runtimeState = state;
          runtimeDetail = detail;
          console.info(`[DisQord/Discord] ${state}${detail ? `: ${detail}` : ''}`);
        },
      })
    : undefined;
  const control = new NodeControlServer({
    host: bootstrap.NODE_WEB_HOST,
    port: bootstrap.NODE_WEB_PORT,
    staticRoot: resolve(bootstrap.NODE_WEB_ROOT),
    ...(bootstrap.NODE_WEB_TOKEN ? { adminToken: bootstrap.NODE_WEB_TOKEN } : {}),
    getStatus: () => ({
      program: 'discord-node',
      configured: Boolean(env),
      state: runtimeState,
      ...(runtimeDetail ? { detail: runtimeDetail } : {}),
      centralUrl: env?.CENTRAL_WSS_URL ?? persisted?.centralUrl ?? '',
      platformConnected,
      startedAt,
      logPath: resolve(bootstrap.NODE_LOG_PATH),
      configuration: {
        centralUrl: env?.CENTRAL_WSS_URL ?? persisted?.centralUrl ?? '',
        allowInsecureCentral:
          env?.ALLOW_INSECURE_CENTRAL === 'true' || persisted?.allowInsecureCentral === true,
        platformTokenConfigured: Boolean(env?.DISCORD_BOT_TOKEN || persisted?.discordBotToken),
      },
    }),
    refreshSessions: async () => {
      if (!runtime) throw new Error('请先完成节点配置。');
      await runtime.refreshSessions();
    },
    ...(runtime ? { getLogs: (query) => runtime.listLogs(query) } : {}),
    saveSetup: async (input) => {
      const submitted = z
        .object({
          centralUrl: webSocketUrlSchema,
          discordBotToken: z.string().max(10_000).optional(),
          allowInsecureCentral: z.boolean().default(false),
        })
        .parse(input);
      await setupStore.save(
        discordSetupSchema.parse({
          ...submitted,
          discordBotToken:
            submitted.discordBotToken?.trim() ||
            env?.DISCORD_BOT_TOKEN ||
            persisted?.discordBotToken ||
            '',
        }),
      );
      const restartRequired = environment.DISQORD_AUTO_RESTART === 'true';
      if (restartRequired) setTimeout(() => process.exit(0), 400).unref();
      return { restartRequired };
    },
  });
  await control.listen();
  if (runtime) {
    try {
      await runtime.start();
      platformConnected = true;
    } catch (error) {
      runtimeState = 'retrying';
      runtimeDetail = error instanceof Error ? error.message : '节点启动失败。';
      console.error(`[DisQord/Discord] ${runtimeDetail}`);
    }
  }
  const shutdown = () =>
    void Promise.all([runtime?.stop(), control.close()]).finally(() => process.exit(0));
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
