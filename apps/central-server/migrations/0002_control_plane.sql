CREATE TABLE central_kv (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE INDEX central_kv_namespace_updated_idx
ON central_kv (namespace, updated_at DESC);

CREATE TABLE central_secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  initialization_vector TEXT NOT NULL,
  authentication_tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

