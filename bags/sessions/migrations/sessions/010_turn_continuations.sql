CREATE TABLE session_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting_for_input','recovery_required','completed','failed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  policy_json TEXT NOT NULL,
  run_id TEXT NOT NULL,
  continuation_json TEXT,
  continuation_hash TEXT,
  owner TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, request_id)
);
CREATE UNIQUE INDEX session_turns_one_active ON session_turns(session_id)
  WHERE state IN ('running','waiting_for_input','recovery_required');

CREATE TABLE session_run_segments (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('accepted','running','interrupted','completed','failed','cancelled')),
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE session_interrupts (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES session_run_segments(id),
  call_id TEXT NOT NULL,
  call_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired','cancelled')),
  expires_at TEXT,
  decision_json TEXT,
  UNIQUE(turn_id, call_id)
);
CREATE TABLE session_resolution_receipts (
  turn_id TEXT NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  decisions_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES session_run_segments(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(turn_id, request_id)
);
CREATE TABLE session_call_outcomes (
  turn_id TEXT NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  call_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('executing','completed','failed','denied','uncertain')),
  outcome_json TEXT,
  owner TEXT NOT NULL,
  PRIMARY KEY(turn_id, call_id)
);
CREATE TABLE session_execution_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES session_run_segments(id),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX session_execution_events_replay ON session_execution_events(session_id, sequence);
