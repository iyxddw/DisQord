CREATE TABLE nodes (
  id UUID PRIMARY KEY,
  node_type TEXT NOT NULL CHECK (node_type IN ('qq', 'discord')),
  display_name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'online', 'offline', 'revoked')),
  version TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY,
  node_id UUID NOT NULL REFERENCES nodes(id),
  platform TEXT NOT NULL CHECK (platform IN ('qq', 'discord')),
  external_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'disabled', 'stale')),
  verified_at TIMESTAMPTZ,
  last_successful_send_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (node_id, external_id)
);

CREATE TABLE chat_session_verifications (
  id UUID PRIMARY KEY,
  chat_session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  code_digest TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX chat_session_verifications_active_idx
ON chat_session_verifications (chat_session_id, expires_at)
WHERE consumed_at IS NULL;

CREATE TABLE prompt_versions (
  id UUID PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (
    purpose IN (
      'translation-system',
      'translation-task',
      'moderation-system',
      'moderation-rules'
    )
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  content TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  UNIQUE (purpose, version)
);

CREATE UNIQUE INDEX prompt_versions_one_published_per_purpose_idx
ON prompt_versions (purpose)
WHERE status = 'published';

CREATE TABLE blueprints (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  active_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE blueprint_versions (
  id UUID PRIMARY KEY,
  blueprint_id UUID NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  graph JSONB NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  UNIQUE (blueprint_id, version)
);

ALTER TABLE blueprints
ADD CONSTRAINT blueprints_active_version_fk
FOREIGN KEY (id, active_version)
REFERENCES blueprint_versions (blueprint_id, version)
DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE message_events (
  id UUID PRIMARY KEY,
  trace_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  source_node_id UUID NOT NULL REFERENCES nodes(id),
  source_session_id UUID NOT NULL REFERENCES chat_sessions(id),
  source_message_id TEXT NOT NULL,
  envelope JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX message_events_trace_idx ON message_events (trace_id);
CREATE INDEX message_events_source_idx
ON message_events (source_session_id, source_message_id);

CREATE TABLE delivery_tasks (
  id UUID PRIMARY KEY,
  trace_id UUID NOT NULL,
  message_event_id UUID NOT NULL REFERENCES message_events(id),
  blueprint_id UUID NOT NULL REFERENCES blueprints(id),
  blueprint_version INTEGER NOT NULL,
  target_session_id UUID NOT NULL REFERENCES chat_sessions(id),
  status TEXT NOT NULL CHECK (
    status IN (
      'received',
      'blueprint_matched',
      'moderating',
      'translating',
      'rendering',
      'queued',
      'sent',
      'acknowledged',
      'pending_review',
      'retrying',
      'blocked',
      'dead_letter'
    )
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  payload JSONB NOT NULL,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX delivery_tasks_dispatch_idx
ON delivery_tasks (status, created_at);

CREATE TABLE message_mappings (
  id UUID PRIMARY KEY,
  message_event_id UUID NOT NULL REFERENCES message_events(id),
  target_session_id UUID NOT NULL REFERENCES chat_sessions(id),
  target_message_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (message_event_id, target_session_id),
  UNIQUE (target_session_id, target_message_id)
);

CREATE TABLE moderation_events (
  id UUID PRIMARY KEY,
  trace_id UUID NOT NULL,
  delivery_task_id UUID NOT NULL REFERENCES delivery_tasks(id),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'review', 'block')),
  categories JSONB NOT NULL,
  reason TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL CHECK (prompt_version > 0),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE trace_events (
  id UUID PRIMARY KEY,
  trace_id UUID NOT NULL,
  node_id UUID REFERENCES nodes(id),
  blueprint_id UUID REFERENCES blueprints(id),
  blueprint_version INTEGER,
  chat_session_id UUID REFERENCES chat_sessions(id),
  stage TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'skipped')),
  duration_ms INTEGER CHECK (duration_ms >= 0),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX trace_events_trace_created_idx
ON trace_events (trace_id, created_at);

CREATE TABLE administrator_audit_logs (
  id UUID PRIMARY KEY,
  administrator_id UUID NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  before_digest TEXT,
  after_digest TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

