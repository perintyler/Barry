// Generated from SQL migrations. Run pnpm stores:generate; do not edit.
export default [
  {
    "name": "001_baseline.sql",
    "sql": "CREATE TABLE IF NOT EXISTS changes (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  session_id TEXT NOT NULL,\n  file_path TEXT NOT NULL,\n  tool TEXT,\n  diff TEXT,\n  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),\n  created_at TEXT NOT NULL DEFAULT (datetime('now'))\n);\n\nCREATE INDEX IF NOT EXISTS idx_changes_session_sequence\n  ON changes(session_id, id);\nCREATE INDEX IF NOT EXISTS idx_changes_path\n  ON changes(file_path);\n\nCREATE TRIGGER IF NOT EXISTS changes_are_append_only_update\nBEFORE UPDATE ON changes\nBEGIN\n  SELECT RAISE(ABORT, 'file changes are append-only');\nEND;\n\nCREATE TRIGGER IF NOT EXISTS changes_are_append_only_delete\nBEFORE DELETE ON changes\nBEGIN\n  SELECT RAISE(ABORT, 'file changes are append-only');\nEND;\n"
  },
  {
    "name": "002_retention_cursor.sql",
    "sql": "-- Cursor keeps unknown or pinned sessions from starving later eligible records.\nCREATE TABLE tracker_retention (\n  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\n  cursor TEXT NOT NULL DEFAULT ''\n);\nINSERT INTO tracker_retention(singleton) VALUES (1);\n"
  }
];
