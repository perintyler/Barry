
    CREATE TABLE IF NOT EXISTS error_event (
      id      TEXT PRIMARY KEY,
      ts      INTEGER NOT NULL,
      level   INTEGER NOT NULL,
      service TEXT NOT NULL,
      msg     TEXT NOT NULL,
      detail  TEXT NOT NULL DEFAULT '',
      ctx     TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_error_ts ON error_event(ts);
    CREATE INDEX IF NOT EXISTS idx_error_service ON error_event(service, ts);
    CREATE INDEX IF NOT EXISTS idx_error_msg ON error_event(msg, ts);
    -- Per-file byte offset, so a normal ingest pass reads only the bytes
    -- appended since the last one instead of re-scanning the whole file. Keyed
    -- by the file's own path: the offset belongs to the file on disk, not to
    -- whatever service label currently points at it.
    --
    -- Added after the fact, and no migration is needed: openBagStore runs this
    -- DDL on every open and every statement is IF NOT EXISTS, so an errors.db
    -- predating offsets grows the table on its next open and starts from
    -- offset 0 — one full re-read, deduped by id, incremental from then on.
    
  CREATE TABLE IF NOT EXISTS file_offset (
    file   TEXT PRIMARY KEY,
    offset INTEGER NOT NULL
  );

  