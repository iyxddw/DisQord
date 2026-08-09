import { llmSettingsSchema } from '@disqord/llm';
import {
  blueprintSchema,
  blueprintVersionSchema,
  chatSessionSchema,
  type NodeRuntimeSettings,
  type UploadSessionFilter,
} from '@disqord/shared';
import { z } from 'zod';

import { type StateStore } from './state-store.js';

const chatInputConfigSchema = z.object({ sessionId: z.uuid() });
const DEFAULT_FAST_DELIVERY_INTERVAL_MS = 1_500;

export async function resolveNodeRuntimeSettings(
  store: StateStore,
  nodeId: string,
): Promise<NodeRuntimeSettings> {
  const llmEntry = await store.get('settings', 'llm');
  const llmSettings = llmSettingsSchema.safeParse(llmEntry?.value);
  return {
    fastMode: llmSettings.success ? llmSettings.data.fastMode : false,
    fastDeliveryIntervalMs: llmSettings.success
      ? llmSettings.data.fastDeliveryIntervalMs
      : DEFAULT_FAST_DELIVERY_INTERVAL_MS,
    uploadSessions: await resolveUploadSessions(store, nodeId),
  };
}

export async function resolveUploadSessions(
  store: StateStore,
  nodeId: string,
): Promise<UploadSessionFilter[]> {
  const [blueprintEntries, versionEntries, sessionEntries] = await Promise.all([
    store.list('blueprint'),
    store.list('blueprint-version'),
    store.list('chat-session'),
  ]);
  const blueprints = blueprintEntries.flatMap((entry) => {
    const parsed = blueprintSchema.safeParse(entry.value);
    return parsed.success && parsed.data.enabled && parsed.data.activeVersion ? [parsed.data] : [];
  });
  const activeVersions = new Map(
    blueprints.map((blueprint) => [`${blueprint.id}:${blueprint.activeVersion}`, blueprint]),
  );
  const sourceSessionIds = new Set<string>();
  for (const entry of versionEntries) {
    const parsed = blueprintVersionSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.status !== 'published') continue;
    if (!activeVersions.has(`${parsed.data.blueprintId}:${parsed.data.version}`)) continue;
    for (const node of parsed.data.nodes) {
      if (node.type !== 'chat-input') continue;
      const config = chatInputConfigSchema.safeParse(node.config);
      if (config.success) sourceSessionIds.add(config.data.sessionId);
    }
  }

  const unique = new Map<string, UploadSessionFilter>();
  for (const entry of sessionEntries) {
    const parsed = chatSessionSchema.safeParse(entry.value);
    if (!parsed.success) continue;
    const session = parsed.data;
    if (
      session.nodeId !== nodeId ||
      session.status !== 'verified' ||
      !sourceSessionIds.has(session.id)
    ) {
      continue;
    }
    const filter = { spaceId: session.spaceId, channelId: session.externalId };
    unique.set(`${filter.spaceId}\u001f${filter.channelId}`, filter);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.spaceId.localeCompare(right.spaceId) || left.channelId.localeCompare(right.channelId),
  );
}
