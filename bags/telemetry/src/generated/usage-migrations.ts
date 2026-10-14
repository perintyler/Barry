// Generated from SQL migrations. Run pnpm stores:generate; do not edit.
export default [
  {
    "name": "001_baseline.sql",
    "sql": "\n    CREATE TABLE IF NOT EXISTS session_usage (\n      id                 TEXT PRIMARY KEY,\n      session_id         TEXT NOT NULL,\n      model              TEXT,\n      input_tokens       INTEGER,\n      output_tokens      INTEGER,\n      cache_read_tokens  INTEGER,\n      cache_write_tokens INTEGER,\n      total_tokens       INTEGER,\n      cost_usd           REAL,\n      num_turns          INTEGER,\n      duration_ms        INTEGER,\n      status             TEXT NOT NULL,\n      created_at         INTEGER NOT NULL\n    );\n\n    CREATE INDEX IF NOT EXISTS idx_session_usage_created ON session_usage(created_at);\n    CREATE INDEX IF NOT EXISTS idx_session_usage_session ON session_usage(session_id);\n\n    CREATE TABLE IF NOT EXISTS tool_invocation (\n      id          TEXT PRIMARY KEY,\n      session_id  TEXT NOT NULL,\n      tool_use_id TEXT,\n      name        TEXT NOT NULL,\n      duration_ms INTEGER NOT NULL,\n      is_error    INTEGER,\n      created_at  INTEGER NOT NULL\n    );\n\n    CREATE INDEX IF NOT EXISTS idx_tool_invocation_name ON tool_invocation(name, created_at);\n    CREATE INDEX IF NOT EXISTS idx_tool_invocation_created ON tool_invocation(created_at);\n  "
  }
];
