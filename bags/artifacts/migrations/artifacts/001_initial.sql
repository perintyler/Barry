CREATE TABLE IF NOT EXISTS artifact_catalog (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  identity_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1)
) STRICT;
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  kind TEXT NOT NULL CHECK (kind IN ('markdown','text','code','html','svg','image','csv','diff','binary')),
  created_at TEXT NOT NULL,
  creator_actor_id INTEGER NOT NULL CHECK (creator_actor_id > 0),
  creator_identity_id TEXT NOT NULL,
  session_id TEXT,
  derived_from TEXT REFERENCES artifacts(id)
) STRICT;
CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(session_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS artifact_metadata (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),
  title TEXT,
  tags TEXT NOT NULL CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS artifacts_owned BEFORE INSERT ON artifacts
WHEN NEW.identity_id IS NOT (SELECT identity_id FROM artifact_catalog WHERE singleton = 1)
BEGIN SELECT RAISE(ABORT, 'Artifact identity does not own this catalog'); END;
CREATE TRIGGER IF NOT EXISTS artifacts_immutable BEFORE UPDATE ON artifacts
BEGIN SELECT RAISE(ABORT, 'Artifact content and provenance are immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifacts_retained BEFORE DELETE ON artifacts
BEGIN SELECT RAISE(ABORT, 'Artifact deletion is not supported'); END;
CREATE TRIGGER IF NOT EXISTS artifact_metadata_revision BEFORE UPDATE ON artifact_metadata
WHEN NEW.artifact_id IS NOT OLD.artifact_id OR NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'Metadata updates require the next revision'); END;
CREATE TRIGGER IF NOT EXISTS artifact_metadata_retained BEFORE DELETE ON artifact_metadata
BEGIN SELECT RAISE(ABORT, 'Artifact metadata deletion is not supported'); END;
CREATE TRIGGER IF NOT EXISTS artifact_catalog_immutable BEFORE UPDATE ON artifact_catalog
BEGIN SELECT RAISE(ABORT, 'Artifact catalog identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_catalog_retained BEFORE DELETE ON artifact_catalog
BEGIN SELECT RAISE(ABORT, 'Artifact catalog identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifacts_no_replacement BEFORE INSERT ON artifacts
WHEN EXISTS (SELECT 1 FROM artifacts WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Artifact content and provenance are immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_catalog_no_replacement BEFORE INSERT ON artifact_catalog
WHEN EXISTS (SELECT 1 FROM artifact_catalog WHERE singleton = NEW.singleton)
BEGIN SELECT RAISE(ABORT, 'Artifact catalog identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_metadata_no_replacement BEFORE INSERT ON artifact_metadata
WHEN EXISTS (SELECT 1 FROM artifact_metadata WHERE artifact_id = NEW.artifact_id)
BEGIN SELECT RAISE(ABORT, 'Metadata updates require the next revision'); END;
