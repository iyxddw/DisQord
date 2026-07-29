import { z } from 'zod';

export const internalIdSchema = z.uuid();
export const externalIdSchema = z.string().trim().min(1).max(256);
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export type Position = z.infer<typeof positionSchema>;
