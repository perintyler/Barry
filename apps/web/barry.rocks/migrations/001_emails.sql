CREATE TABLE emails (
  id          TEXT PRIMARY KEY,
  message_id  TEXT UNIQUE,
  from_email  TEXT NOT NULL,
  from_name   TEXT,
  to_email    TEXT NOT NULL,
  subject     TEXT,
  received_at INTEGER NOT NULL,
  read        INTEGER NOT NULL DEFAULT 0,
  body_key    TEXT NOT NULL
);

CREATE INDEX emails_received_at ON emails (received_at DESC);
CREATE INDEX emails_read ON emails (read);
