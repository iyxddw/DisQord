import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class NodeSetupStore<T extends Record<string, unknown>> {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<T | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#path, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Node setup file must contain a JSON object.');
      }
      return value as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(value: T): Promise<void> {
    const directory = dirname(this.#path);
    const temporaryPath = `${this.#path}.${process.pid}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, this.#path);
    await chmod(this.#path, 0o600).catch(() => undefined);
  }
}
