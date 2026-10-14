CREATE TABLE IF NOT EXISTS share_grants (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  identity_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL CHECK (revoked IN (0, 1)),
  password_salt TEXT,
  password_hash TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS share_grants_artifact ON share_grants(artifact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS share_grants_token_hash ON share_grants(token_hash);

CREATE TRIGGER IF NOT EXISTS share_grants_owned BEFORE INSERT ON share_grants
WHEN NEW.identity_id IS NOT (SELECT identity_id FROM artifact_catalog WHERE singleton = 1)
BEGIN SELECT RAISE(ABORT, 'Artifact identity does not own this catalog'); END;

CREATE TRIGGER IF NOT EXISTS share_grants_revision BEFORE UPDATE ON share_grants
WHEN NEW.id IS NOT OLD.id OR NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'Share updates require the next revision'); END;

CREATE TRIGGER IF NOT EXISTS share_grants_generation_insert BEFORE INSERT ON share_grants
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER IF NOT EXISTS share_grants_generation_update BEFORE UPDATE ON share_grants
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
CREATE TRIGGER IF NOT EXISTS share_grants_generation_delete BEFORE DELETE ON share_grants
WHEN (SELECT state FROM artifact_generation_status WHERE singleton = 1) = 'sealed'
BEGIN SELECT RAISE(ABORT, 'Artifact generation is sealed'); END;
