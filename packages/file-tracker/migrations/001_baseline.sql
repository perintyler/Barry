CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  tool TEXT,
  diff TEXT,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_changes_session_sequence
  ON changes(session_id, id);
CREATE INDEX IF NOT EXISTS idx_changes_path
  ON changes(file_path);

CREATE TRIGGER IF NOT EXISTS changes_are_append_only_update
BEFORE UPDATE ON changes
BEGIN
  SELECT RAISE(ABORT, 'file changes are append-only');
END;

CREATE TRIGGER IF NOT EXISTS changes_are_append_only_delete
BEFORE DELETE ON changes
BEGIN
  SELECT RAISE(ABORT, 'file changes are append-only');
END;
