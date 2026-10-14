
    CREATE TABLE IF NOT EXISTS metric_point (
      -- Unix SECONDS. See the UNITS note above.
      ts      INTEGER NOT NULL,
      metric  TEXT    NOT NULL,
      value   REAL    NOT NULL,
      labels  TEXT    NOT NULL DEFAULT '{}'
    );

    -- Every query is "this metric, this window", so metric leads the index.
    CREATE INDEX IF NOT EXISTS idx_point_metric_ts ON metric_point(metric, ts);
    -- Retention sweeps scan by time across all metrics.
    CREATE INDEX IF NOT EXISTS idx_point_ts ON metric_point(ts);

    CREATE TABLE IF NOT EXISTS rollup_hourly (
      -- Unix SECONDS, truncated to the hour by hourBucket().
      bucket  INTEGER NOT NULL,
      metric  TEXT    NOT NULL,
      labels  TEXT    NOT NULL DEFAULT '{}',
      min     REAL    NOT NULL,
      max     REAL    NOT NULL,
      avg     REAL    NOT NULL,
      last    REAL    NOT NULL,
      count   INTEGER NOT NULL,
      PRIMARY KEY (bucket, metric, labels)
    );

    CREATE INDEX IF NOT EXISTS idx_rollup_metric_bucket ON rollup_hourly(metric, bucket);

    -- Alert state, so a rule fires on TRANSITION rather than on every tick.
    -- Same discipline as the existing health-check job: repeated identical
    -- alerts train you to ignore them.
    CREATE TABLE IF NOT EXISTS alert_state (
      rule      TEXT PRIMARY KEY,
      firing    INTEGER NOT NULL,
      -- Both unix SECONDS, matching metric_point.ts.
      since     INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      detail    TEXT NOT NULL DEFAULT ''
    );
  