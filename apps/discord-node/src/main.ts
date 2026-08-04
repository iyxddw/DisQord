import { startDiscordNode } from './index.js';

void startDiscordNode().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
