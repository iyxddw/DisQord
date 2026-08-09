import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NapCatOneBotClient } from '@disqord/adapter-napcat';
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

const bootstrapEnvSchema = envSchema
  .pick({
    NODE_CONFIG_PATH: true,
    NODE_QUEUE_PATH: true,
    NODE_LOG_PATH: true,
    NODE_WEB_HOST: true,
    NODE_WEB_PORT: true,
    NODE_WEB_TOKEN: true,
    NODE_WEB_ROOT: true,
  })
  .extend({ NODE_SETUP_PATH: z.string().min(1).default('./data/qq-setup.json') });

const webSocketUrlSchema = z
  .url()
  .refine(
    (value) => ['ws:', 'wss:'].includes(new URL(value).protocol),
    '必须使用 ws:// 或 wss://。',
  );
const qqSetupSchema = z.object({
  centralUrl: webSocketUrlSchema,
  napcatUrl: webSocketUrlSchema,
  napcatAccessToken: z.string().max(10_000).default(''),
  allowInsecureCentral: z.boolean().default(false),
});
type QqSetup = z.infer<typeof qqSetupSchema>;

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
  const bootstrap = bootstrapEnvSchema.parse(environment);
  const setupStore = new NodeSetupStore<QqSetup>(resolve(bootstrap.NODE_SETUP_PATH));
  const rawPersisted = await setupStore.load();
  const persistedResult = qqSetupSchema.safeParse(rawPersisted);
  const persisted = persistedResult.success ? persistedResult.data : undefined;
  const combinedEnvironment = {
    ...environment,
    ...(environment.CENTRAL_WSS_URL || !persisted ? {} : { CENTRAL_WSS_URL: persisted.centralUrl }),
    ...(environment.NAPCAT_ONEBOT_WS_URL || !persisted
      ? {}
      : { NAPCAT_ONEBOT_WS_URL: persisted.napcatUrl }),
    ...(environment.NAPCAT_ACCESS_TOKEN !== undefined || !persisted
      ? {}
      : { NAPCAT_ACCESS_TOKEN: persisted.napcatAccessToken }),
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
      })
    : undefined;
  const control = new NodeControlServer({
    host: bootstrap.NODE_WEB_HOST,
    port: bootstrap.NODE_WEB_PORT,
    staticRoot: resolve(bootstrap.NODE_WEB_ROOT),
    ...(bootstrap.NODE_WEB_TOKEN ? { adminToken: bootstrap.NODE_WEB_TOKEN } : {}),
    getStatus: () => ({
      program: 'qq-node',
      configured: Boolean(env),
      state: runtimeState,
      ...(runtimeDetail ? { detail: runtimeDetail } : {}),
      centralUrl: env?.CENTRAL_WSS_URL ?? persisted?.centralUrl ?? '',
      platformConnected,
      startedAt,
      logPath: resolve(bootstrap.NODE_LOG_PATH),
      configuration: {
        centralUrl: env?.CENTRAL_WSS_URL ?? persisted?.centralUrl ?? '',
        platformUrl: env?.NAPCAT_ONEBOT_WS_URL ?? persisted?.napcatUrl ?? 'ws://127.0.0.1:3001',
        allowInsecureCentral:
          env?.ALLOW_INSECURE_CENTRAL === 'true' || persisted?.allowInsecureCentral === true,
        platformTokenConfigured: Boolean(env?.NAPCAT_ACCESS_TOKEN || persisted?.napcatAccessToken),
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
          napcatUrl: webSocketUrlSchema,
          napcatAccessToken: z.string().max(10_000).optional(),
          allowInsecureCentral: z.boolean().default(false),
        })
        .parse(input);
      await setupStore.save(
        qqSetupSchema.parse({
          ...submitted,
          napcatAccessToken:
            submitted.napcatAccessToken?.trim() ||
            env?.NAPCAT_ACCESS_TOKEN ||
            persisted?.napcatAccessToken ||
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
      console.error(`[DisQord/QQ] ${runtimeDetail}`);
    }
  }
  const shutdown = () =>
    void Promise.all([runtime?.stop(), control.close()]).finally(() => process.exit(0));
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
