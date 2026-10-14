
      CREATE TABLE IF NOT EXISTS log_event (
        id      TEXT PRIMARY KEY,
        ts      INTEGER NOT NULL,
        level   INTEGER NOT NULL,
        service TEXT NOT NULL,
        msg     TEXT NOT NULL,
        ctx     TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_log_level_ts ON log_event(level, ts);
      CREATE INDEX IF NOT EXISTS idx_log_ts ON log_event(ts);
      CREATE INDEX IF NOT EXISTS idx_log_service_ts ON log_event(service, ts);
      
  CREATE TABLE IF NOT EXISTS file_offset (
    file   TEXT PRIMARY KEY,
    offset INTEGER NOT NULL
  );

    