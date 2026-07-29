import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { generateNodeIdentity, nodeIdentitySchema, type NodeIdentity } from '@disqord/transport';
import { z } from 'zod';

const persistedNodeConfigSchema = z.object({
  identity: nodeIdentitySchema,
  sessionToken: z.string().min(32).optional(),
});

export type PersistedNodeConfig = z.infer<typeof persistedNodeConfigSchema>;

export class NodeConfigStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async loadOrCreate(nodeType: NodeIdentity['nodeType']): Promise<PersistedNodeConfig> {
    try {
      const parsed = persistedNodeConfigSchema.parse(
        JSON.parse(await readFile(this.#path, 'utf8')),
      );
      if (parsed.identity.nodeType !== nodeType) {
        throw new Error(`Node config belongs to ${parsed.identity.nodeType}, not ${nodeType}.`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const created = { identity: generateNodeIdentity(nodeType) };
      await this.save(created);
      return created;
    }
  }

  async save(config: PersistedNodeConfig): Promise<void> {
    const validated = persistedNodeConfigSchema.parse(config);
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.#path, 0o600).catch(() => undefined);
  }
}
