import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('central PostgreSQL initial migration', () => {
  it('creates the authoritative phase 1 entities', async () => {
    const sql = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');

    for (const table of [
      'nodes',
      'chat_sessions',
      'chat_session_verifications',
      'prompt_versions',
      'blueprints',
      'blueprint_versions',
      'message_events',
      'delivery_tasks',
      'message_mappings',
      'moderation_events',
      'trace_events',
      'administrator_audit_logs',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
  });

  it('does not contain destructive migration statements', async () => {
    const sql = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');

    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE)\b/iu);
  });
});
