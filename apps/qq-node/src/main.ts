import { startQqNode } from './index.js';

void startQqNode().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
