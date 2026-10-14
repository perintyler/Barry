CREATE TABLE IF NOT EXISTS artifact_storage_generation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  token TEXT NOT NULL CHECK (length(token) = 32 AND token NOT GLOB '*[^a-f0-9]*')
) STRICT;
INSERT INTO artifact_storage_generation
SELECT 1, lower(hex(randomblob(16))) WHERE NOT EXISTS (SELECT 1 FROM artifact_storage_generation);
CREATE TRIGGER IF NOT EXISTS artifact_generation_immutable BEFORE UPDATE ON artifact_storage_generation
BEGIN SELECT RAISE(ABORT, 'Artifact storage generation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_generation_retained BEFORE DELETE ON artifact_storage_generation
BEGIN SELECT RAISE(ABORT, 'Artifact storage generation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS artifact_generation_no_replacement BEFORE INSERT ON artifact_storage_generation
WHEN EXISTS (SELECT 1 FROM artifact_storage_generation)
BEGIN SELECT RAISE(ABORT, 'Artifact storage generation is immutable'); END;
CREATE INDEX IF NOT EXISTS artifacts_hash ON artifacts(sha256);
CREATE TABLE IF NOT EXISTS blob_deletions (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL CHECK (size >= 0 AND size <= 26214400),
  token TEXT NOT NULL UNIQUE,
  marked_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS blob_gc_completed (
  sha256 TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS intent_cleanup (
  intent_id TEXT PRIMARY KEY REFERENCES blob_intents(id),
  cleaned_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS artifact_blob_pins (
  pin_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (pin_id, sha256)
) STRICT;
CREATE TABLE IF NOT EXISTS artifact_maintenance_progress (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS artifacts_not_deleting BEFORE INSERT ON artifacts
WHEN EXISTS (SELECT 1 FROM blob_deletions WHERE sha256 = NEW.sha256)
BEGIN SELECT RAISE(ABORT, 'Artifact blob is being deleted'); END;
CREATE TRIGGER IF NOT EXISTS pins_not_deleting BEFORE INSERT ON artifact_blob_pins
WHEN EXISTS (SELECT 1 FROM blob_deletions WHERE sha256 = NEW.sha256)
BEGIN SELECT RAISE(ABORT, 'Artifact blob is being deleted'); END;
INSERT OR IGNORE INTO artifact_schema_migrations VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
