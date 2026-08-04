import { startCentralServer } from './index.js';

void startCentralServer().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Central server failed to start.');
  process.exitCode = 1;
});
