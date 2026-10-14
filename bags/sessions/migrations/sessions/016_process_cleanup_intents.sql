CREATE TABLE process_cleanup_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id INTEGER,
  identity_id INTEGER,
  action TEXT NOT NULL CHECK(action IN ('close','delete')),
  target_path TEXT NOT NULL,
  instances TEXT NOT NULL CHECK(json_valid(instances)),
  ended_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
