import { z } from 'zod';

import { externalIdSchema } from './common.js';

/** A platform conversation that a node is allowed to upload to central. */
export const uploadSessionFilterSchema = z.object({
  spaceId: externalIdSchema,
  channelId: externalIdSchema,
});

export const nodeRuntimeSettingsSchema = z.object({
  fastMode: z.boolean().default(false),
  fastDeliveryIntervalMs: z.number().int().min(0).max(60_000).default(1_500),
  /**
   * Optional for rolling upgrades. Missing means an older central server and
   * therefore keeps the legacy upload-all behavior; an empty list means that
   * the node must not upload any platform conversation.
   */
  uploadSessions: z.array(uploadSessionFilterSchema).max(10_000).optional(),
});

export type UploadSessionFilter = z.infer<typeof uploadSessionFilterSchema>;
export type NodeRuntimeSettings = z.infer<typeof nodeRuntimeSettingsSchema>;
