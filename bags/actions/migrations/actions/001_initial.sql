
      CREATE TABLE action_runs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        bag TEXT NOT NULL,
        -- Soft reference to ~/.barry/<env>/sessions.db. Deliberately not a
        -- foreign key -- see the module comment.
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'started',
        summary TEXT,
        -- JSON text. Was jsonb; read whole, never queried by key.
        metadata TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        validated_at TEXT,
        -- JSON array text. NULL = the action declared no checks; '[]' = checks
        -- ran and all passed. The three-valued distinction is load-bearing:
        -- "not checked" and "checked and fine" must not read alike.
        validation_failures TEXT,
        -- Plain text, stored verbatim; output_type says how to read it back.
        output TEXT,
        output_type TEXT,
        -- Carried over from migration 022. Both columns move together
        -- or neither does: an output with no type cannot be read back, and a
        -- type with no output describes nothing.
        CONSTRAINT action_runs_output_paired CHECK ((output IS NULL) = (output_type IS NULL))
      );

      -- The list pages by started_at, the per-action view filters by action,
      -- list-open-action-runs wants the open ones, and the sweep filters by
      -- session_id.
      CREATE INDEX idx_action_runs_started_at ON action_runs(started_at DESC);
      CREATE INDEX idx_action_runs_action ON action_runs(action, started_at DESC);
      CREATE INDEX idx_action_runs_open ON action_runs(started_at DESC) WHERE completed_at IS NULL;
      CREATE INDEX idx_action_runs_session_id ON action_runs(session_id) WHERE session_id IS NOT NULL;
    