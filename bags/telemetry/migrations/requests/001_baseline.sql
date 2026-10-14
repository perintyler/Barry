
    CREATE TABLE IF NOT EXISTS request (
      id          TEXT PRIMARY KEY,
      service     TEXT NOT NULL,
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      status      INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      ts          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_request_ts ON request(ts);
    CREATE INDEX IF NOT EXISTS idx_request_path ON request(path, ts);
    CREATE INDEX IF NOT EXISTS idx_request_service ON request(service, ts);
    -- Per-file byte offset, so a normal ingest pass reads only the bytes
    -- appended since the last one instead of re-scanning the whole file. Keyed
    -- by the file's own path: the offset belongs to the file on disk, not to
    -- whatever service label currently points at it.
    CREATE TABLE IF NOT EXISTS file_offset (
      file   TEXT PRIMARY KEY,
      offset INTEGER NOT NULL
    );
  