import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { PromptVersionStore } from '@disqord/llm';
import { createProgramDescriptor } from '@disqord/shared';
import { PairingAuthority, type NodeSession } from '@disqord/transport';
import { z } from 'zod';

import { createCentralApplication } from './api.js';
import { CentralMessageProcessor, MessageOrchestrator } from './orchestrator.js';
import { FileStateStore, PlaintextSecretStore, type StateStore } from './state-store.js';

export * from './api.js';
export * from './auth.js';
export * from './orchestrator.js';
export * from './simulation.js';
export * from './state-store.js';

export const program = createProgramDescriptor('central-server');

const environmentSchema = z.object({
  CENTRAL_HOST: z.string().default('127.0.0.1'),
  CENTRAL_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  CENTRAL_DATA_PATH: z.string().min(1).default('./data/central.json'),
  CENTRAL_AVATAR_CACHE_PATH: z.string().min(1).default('./data/avatar-cache'),
  PAIRING_PEPPER: z.string().min(32),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export async function startCentralServer(environment: NodeJS.ProcessEnv = process.env) {
  const config = environmentSchema.parse(environment);
  const store = new FileStateStore(resolve(config.CENTRAL_DATA_PATH));
  const secrets = new PlaintextSecretStore(store);
  await ensureDefaultPrompts(store);
  const pairingAuthority = new PairingAuthority(config.PAIRING_PEPPER);
  for (const entry of await store.list<NodeSession>('node-session')) {
    pairingAuthority.restoreSession(entry.value);
  }
  const orchestratorRef: { current?: MessageOrchestrator } = {};
  const central = createCentralApplication({
    store,
    secrets,
    pairingAuthority,
    verificationSecret: config.PAIRING_PEPPER,
    secureCookies: config.COOKIE_SECURE,
    attachNodeGateway: true,
    onNodeFrame: async (frame) => await orchestratorRef.current?.handleNodeFrame(frame),
    onReviewAction: async (taskId, decision) =>
      await orchestratorRef.current?.handleReview(taskId, decision),
    onSimulatedInput: async (blueprintId, nodeId, text) => {
      if (!orchestratorRef.current) throw new Error('消息处理器尚未就绪。');
      return await orchestratorRef.current.handleSimulatedInput(blueprintId, nodeId, text);
    },
  });
  const gateway = central.getGateway();
  if (!gateway) throw new Error('Central node gateway failed to initialize.');
  orchestratorRef.current = new MessageOrchestrator(
    store,
    gateway,
    new CentralMessageProcessor(store, secrets, resolve(config.CENTRAL_AVATAR_CACHE_PATH)),
  );
  await central.app.listen({ host: config.CENTRAL_HOST, port: config.CENTRAL_PORT });

  const stop = async () => {
    await central.app.close();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  return { ...central, stop };
}

async function ensureDefaultPrompts(store: StateStore): Promise<void> {
  const existing = await store.list('prompt');
  if (existing.length) return;
  const prompts = new PromptVersionStore();
  prompts.createDefaultVersions(randomUUID());
  for (const purpose of [
    'translation-system',
    'translation-task',
    'moderation-system',
    'moderation-rules',
  ] as const) {
    const prompt = prompts.getPublished(purpose);
    await store.set('prompt', prompt.id, prompt);
  }
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(entryPath).href === import.meta.url) {
  startCentralServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Central server failed to start.');
    process.exitCode = 1;
  });
}
