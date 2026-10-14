
    CREATE TABLE IF NOT EXISTS locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_root TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      UNIQUE (repo_root, rel_path)
    );
    CREATE INDEX IF NOT EXISTS idx_locks_session ON locks(session_id);
    CREATE INDEX IF NOT EXISTS idx_locks_expires ON locks(expires_at);

    -- One row per attempt to work on a file, held or blocked. Survives release,
    -- so this doubles as the record of what has been changing per file.
    CREATE TABLE IF NOT EXISTS intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_root TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      region TEXT,
      state TEXT NOT NULL CHECK (state IN ('held','waiting','released','denied')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_intents_path ON intents(repo_root, rel_path);
    CREATE INDEX IF NOT EXISTS idx_intents_session ON intents(session_id);
    CREATE INDEX IF NOT EXISTS idx_intents_state ON intents(state);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_root TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_path ON events(repo_root, rel_path);
  