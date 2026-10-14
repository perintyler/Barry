// Generated from SQL migrations. Run pnpm stores:generate; do not edit.
export default [
  {
    "name": "001_baseline.sql",
    "sql": "\n    CREATE TABLE IF NOT EXISTS request (\n      id          TEXT PRIMARY KEY,\n      service     TEXT NOT NULL,\n      method      TEXT NOT NULL,\n      path        TEXT NOT NULL,\n      status      INTEGER NOT NULL,\n      duration_ms INTEGER NOT NULL,\n      ts          INTEGER NOT NULL\n    );\n    CREATE INDEX IF NOT EXISTS idx_request_ts ON request(ts);\n    CREATE INDEX IF NOT EXISTS idx_request_path ON request(path, ts);\n    CREATE INDEX IF NOT EXISTS idx_request_service ON request(service, ts);\n    -- Per-file byte offset, so a normal ingest pass reads only the bytes\n    -- appended since the last one instead of re-scanning the whole file. Keyed\n    -- by the file's own path: the offset belongs to the file on disk, not to\n    -- whatever service label currently points at it.\n    CREATE TABLE IF NOT EXISTS file_offset (\n      file   TEXT PRIMARY KEY,\n      offset INTEGER NOT NULL\n    );\n  "
  }
];
