-- Destination bindings reuse session_turns for execution, never a parallel queue.
CREATE TABLE session_workflow_destinations (
  binding_key TEXT PRIMARY KEY REFERENCES session_workflow_bindings(key),
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  identity TEXT NOT NULL,
  identity_id INTEGER NOT NULL,
  actor_id INTEGER NOT NULL,
  scope_json TEXT NOT NULL,
  selection_json TEXT NOT NULL
);
CREATE TABLE session_workflow_destination_turns (
  key TEXT PRIMARY KEY REFERENCES session_workflow_turns(key),
  session_id TEXT NOT NULL REFERENCES session_workflow_destinations(session_id),
  turn_id TEXT NOT NULL UNIQUE REFERENCES session_turns(id),
  request_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE
);
-- Can precede destination admission: cancellation must fence later launch.
CREATE TABLE session_workflow_destination_cancellations (
  key TEXT PRIMARY KEY,
  cancelled_at TEXT NOT NULL
);
-- Each approval continuation segment receives a distinct physical ownership fence.
-- Logical terminal states never clear this evidence or imply cessation.
CREATE TABLE session_workflow_settlements (
  segment_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL REFERENCES session_turns(id),
  owner TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('launching','preparing','not_started','handled','input','closing','ceased')),
  handle_json TEXT,
  input_at TEXT,
  closing_at TEXT,
  ceased_at TEXT,
  created_at TEXT NOT NULL,
  CHECK(phase IN ('launching','preparing','not_started') OR handle_json IS NOT NULL),
  CHECK((phase IN ('ceased','not_started')) = (ceased_at IS NOT NULL))
);
CREATE INDEX session_workflow_unsettled ON session_workflow_settlements(turn_id) WHERE ceased_at IS NULL;
