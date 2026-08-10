-- Action runs: one row per `use_action` call. Phase 1 records that an action
-- was started and (optionally) completed; the row is the seam that validation
-- hooks into next, and it is what makes `complete_action` a checkable contract
-- rather than a no-op.

CREATE TABLE action_runs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  block TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'started',
  summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_action_runs_started_at ON action_runs(started_at DESC);
CREATE INDEX idx_action_runs_session_id ON action_runs(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_action_runs_action ON action_runs(action, started_at DESC);
CREATE INDEX idx_action_runs_open ON action_runs(started_at DESC) WHERE completed_at IS NULL;
