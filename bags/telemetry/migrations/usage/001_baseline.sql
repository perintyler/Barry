
    CREATE TABLE IF NOT EXISTS session_usage (
      id                 TEXT PRIMARY KEY,
      session_id         TEXT NOT NULL,
      model              TEXT,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      cache_read_tokens  INTEGER,
      cache_write_tokens INTEGER,
      total_tokens       INTEGER,
      cost_usd           REAL,
      num_turns          INTEGER,
      duration_ms        INTEGER,
      status             TEXT NOT NULL,
      created_at         INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_usage_created ON session_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_session_usage_session ON session_usage(session_id);

    CREATE TABLE IF NOT EXISTS tool_invocation (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      tool_use_id TEXT,
      name        TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      is_error    INTEGER,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tool_invocation_name ON tool_invocation(name, created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_invocation_created ON tool_invocation(created_at);
  