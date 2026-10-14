CREATE TABLE IF NOT EXISTS workflow_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO workflow_meta VALUES ('format', '1');
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, type TEXT NOT NULL, version TEXT NOT NULL,
  input TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, outcome TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS workflow_runs_status ON workflow_runs(status, started_at);
CREATE TABLE IF NOT EXISTS workflow_groups (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id), position INTEGER NOT NULL, definition TEXT NOT NULL,
  PRIMARY KEY(run_id, position)
);
CREATE TABLE IF NOT EXISTS workflow_commands (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), position INTEGER NOT NULL, slot INTEGER NOT NULL,
  definition TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT,
  deadline INTEGER NOT NULL, ready_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  token TEXT, lease_until INTEGER, attempt_deadline INTEGER,
  UNIQUE(run_id, position, slot)
);
CREATE INDEX IF NOT EXISTS workflow_commands_due ON workflow_commands(state, ready_at);
CREATE INDEX IF NOT EXISTS workflow_commands_run ON workflow_commands(run_id, position, slot);
CREATE TABLE IF NOT EXISTS workflow_attempts (
  token TEXT PRIMARY KEY, command_id TEXT NOT NULL REFERENCES workflow_commands(id), worker TEXT NOT NULL,
  attempt INTEGER NOT NULL, state TEXT NOT NULL, outcome TEXT
);
CREATE INDEX IF NOT EXISTS workflow_attempts_worker ON workflow_attempts(worker, state);
CREATE TABLE IF NOT EXISTS workflow_signals (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  id TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(run_id, id)
);
CREATE INDEX IF NOT EXISTS workflow_signals_pending ON workflow_signals(run_id, name, consumed, sequence);
CREATE TABLE IF NOT EXISTS workflow_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  at INTEGER NOT NULL, type TEXT NOT NULL, details TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_events_run ON workflow_events(run_id, sequence);
