-- alert_state.last_notified, added by a migration rather than by an
-- ALTER TABLE attempted on every sampler tick. Stores that ran that ALTER
-- already have the column and fresh ones do not, and SQLite has no
-- ADD COLUMN IF NOT EXISTS, so the table is rebuilt: the same shape either way.
--
-- An alert firing now keeps its place: last_notified starts at last_seen, so
-- the upgrade can delay its next reminder by at most one interval, and never
-- sends one early.
CREATE TABLE alert_state_next (
  rule          TEXT PRIMARY KEY,
  firing        INTEGER NOT NULL,
  -- All unix SECONDS, matching metric_point.ts.
  since         INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  last_notified INTEGER
);

INSERT INTO alert_state_next (rule, firing, since, last_seen, detail, last_notified)
  SELECT rule, firing, since, last_seen, detail, CASE WHEN firing = 1 THEN last_seen END
  FROM alert_state;

DROP TABLE alert_state;

ALTER TABLE alert_state_next RENAME TO alert_state;
