CREATE TABLE login_event_claims (
  schedule_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (schedule_id, event_id)
) WITHOUT ROWID;
