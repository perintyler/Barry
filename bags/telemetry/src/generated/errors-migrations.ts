// Generated from SQL migrations. Run pnpm stores:generate; do not edit.
export default [
  {
    "name": "001_baseline.sql",
    "sql": "\n    CREATE TABLE IF NOT EXISTS error_event (\n      id      TEXT PRIMARY KEY,\n      ts      INTEGER NOT NULL,\n      level   INTEGER NOT NULL,\n      service TEXT NOT NULL,\n      msg     TEXT NOT NULL,\n      detail  TEXT NOT NULL DEFAULT '',\n      ctx     TEXT NOT NULL DEFAULT '{}'\n    );\n    CREATE INDEX IF NOT EXISTS idx_error_ts ON error_event(ts);\n    CREATE INDEX IF NOT EXISTS idx_error_service ON error_event(service, ts);\n    CREATE INDEX IF NOT EXISTS idx_error_msg ON error_event(msg, ts);\n    -- Per-file byte offset, so a normal ingest pass reads only the bytes\n    -- appended since the last one instead of re-scanning the whole file. Keyed\n    -- by the file's own path: the offset belongs to the file on disk, not to\n    -- whatever service label currently points at it.\n    --\n    -- Added after the fact, and no migration is needed: openBagStore runs this\n    -- DDL on every open and every statement is IF NOT EXISTS, so an errors.db\n    -- predating offsets grows the table on its next open and starts from\n    -- offset 0 — one full re-read, deduped by id, incremental from then on.\n    \n  CREATE TABLE IF NOT EXISTS file_offset (\n    file   TEXT PRIMARY KEY,\n    offset INTEGER NOT NULL\n  );\n\n  "
  }
];
