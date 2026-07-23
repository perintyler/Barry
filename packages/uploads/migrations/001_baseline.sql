CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  artifact_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'uploading', 'uploaded', 'failed')),
  remote_key TEXT,
  remote_url TEXT,
  config TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(config)),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  mime_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_uploads_artifact
  ON uploads(artifact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_provider
  ON uploads(provider);
CREATE INDEX IF NOT EXISTS idx_uploads_token
  ON uploads(token);
