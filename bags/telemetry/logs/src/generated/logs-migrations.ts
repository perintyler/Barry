// Generated from SQL migrations. Run pnpm stores:generate; do not edit.
export default [
  {
    "name": "001_baseline.sql",
    "sql": "\n      CREATE TABLE IF NOT EXISTS log_event (\n        id      TEXT PRIMARY KEY,\n        ts      INTEGER NOT NULL,\n        level   INTEGER NOT NULL,\n        service TEXT NOT NULL,\n        msg     TEXT NOT NULL,\n        ctx     TEXT NOT NULL DEFAULT '{}'\n      );\n\n      CREATE INDEX IF NOT EXISTS idx_log_level_ts ON log_event(level, ts);\n      CREATE INDEX IF NOT EXISTS idx_log_ts ON log_event(ts);\n      CREATE INDEX IF NOT EXISTS idx_log_service_ts ON log_event(service, ts);\n      \n  CREATE TABLE IF NOT EXISTS file_offset (\n    file   TEXT PRIMARY KEY,\n    offset INTEGER NOT NULL\n  );\n\n    "
  }
];
