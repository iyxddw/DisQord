import { z } from 'zod';

export const developerSettingsSchema = z.object({
  replaceUnsupportedMessages: z.boolean().default(true),
});

export type DeveloperSettings = z.infer<typeof developerSettingsSchema>;
