-- Durable intent and receipt records for workflow-owned continuing sessions.
-- The binding row is intentionally written before the session exists, so it
-- cannot have a foreign key to sessions; an interrupted create is reconciled
-- against the session id recorded here. Turn admission is serialized per
-- continuing session until completion or explicit interruption is observed.
CREATE TABLE session_workflow_bindings (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  identity TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('admitted', 'ready'))
);

CREATE TABLE session_workflow_turns (
  key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('admitted', 'active', 'uncertain', 'interrupting', 'interrupted', 'complete')),
  result TEXT
);

CREATE UNIQUE INDEX session_workflow_active_turn
  ON session_workflow_turns(session_id)
  WHERE state IN ('admitted', 'active', 'uncertain', 'interrupting');
