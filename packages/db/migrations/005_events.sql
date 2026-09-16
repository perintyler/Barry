-- Events: a first-class barry primitive for notifications, status updates,
-- task completions, and system alerts. Append-only history that replaces
-- the overwrite-based status_update metadata pattern.

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  data JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  delivered_via TEXT[] NOT NULL DEFAULT '{}',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_created_at ON events(created_at DESC);
CREATE INDEX idx_events_session_id ON events(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_events_type ON events(type, created_at DESC);
CREATE INDEX idx_events_unread ON events(created_at DESC) WHERE read_at IS NULL;
