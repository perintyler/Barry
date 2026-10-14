CREATE TABLE IF NOT EXISTS artifact_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS blob_intents (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading','staged','published','complete','failed')),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*')),
  size INTEGER CHECK (size IS NULL OR (size >= 0 AND size <= 26214400))
) STRICT;
CREATE INDEX IF NOT EXISTS blob_intents_hash ON blob_intents(sha256, status, expires_at);
CREATE TABLE IF NOT EXISTS creation_requests (
  idempotency_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^a-f0-9]*'),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS creation_requests_immutable BEFORE UPDATE ON creation_requests
BEGIN SELECT RAISE(ABORT, 'Creation results are immutable'); END;
CREATE TRIGGER IF NOT EXISTS creation_requests_no_replacement BEFORE INSERT ON creation_requests
WHEN EXISTS (SELECT 1 FROM creation_requests WHERE idempotency_key = NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT, 'Creation results are immutable'); END;
CREATE TRIGGER IF NOT EXISTS creation_requests_retained BEFORE DELETE ON creation_requests
BEGIN SELECT RAISE(ABORT, 'Creation results are retained'); END;
INSERT OR IGNORE INTO artifact_schema_migrations VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT OR IGNORE INTO artifact_schema_migrations VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
