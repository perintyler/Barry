
      CREATE TABLE adhoc_actions (
        -- Soft reference to sessions.db, like action_runs.session_id.
        owner_session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        -- Where the owner session was working, and so where a run starts.
        dir TEXT NOT NULL,
        -- JSON text: the action.yaml fields exactly as the session gave them.
        -- Re-validated on every read, so a definition stored under an older,
        -- looser rule cannot run under the current one.
        definition TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_session_id, name)
      );

      CREATE TABLE action_runs_rebuilt (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        -- NULL = the action came from no bag (an ad-hoc action).
        bag TEXT,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'started',
        summary TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        validated_at TEXT,
        validation_failures TEXT,
        output TEXT,
        output_type TEXT,
        trigger TEXT,
        schedule_id TEXT,
        exit_code INTEGER,
        duration_ms INTEGER,
        log_path TEXT,
        CONSTRAINT action_runs_output_paired CHECK ((output IS NULL) = (output_type IS NULL))
      );

      INSERT INTO action_runs_rebuilt (
        id, action, bag, session_id, status, summary, metadata, started_at,
        completed_at, validated_at, validation_failures, output, output_type,
        trigger, schedule_id, exit_code, duration_ms, log_path
      )
      SELECT
        id, action, bag, session_id, status, summary, metadata, started_at,
        completed_at, validated_at, validation_failures, output, output_type,
        trigger, schedule_id, exit_code, duration_ms, log_path
      FROM action_runs;

      DROP TABLE action_runs;
      ALTER TABLE action_runs_rebuilt RENAME TO action_runs;

      CREATE INDEX idx_action_runs_started_at ON action_runs(started_at DESC);
      CREATE INDEX idx_action_runs_action ON action_runs(action, started_at DESC);
      CREATE INDEX idx_action_runs_open ON action_runs(started_at DESC) WHERE completed_at IS NULL;
      CREATE INDEX idx_action_runs_session_id ON action_runs(session_id) WHERE session_id IS NOT NULL;
      CREATE INDEX idx_action_runs_schedule ON action_runs(schedule_id, started_at DESC)
        WHERE schedule_id IS NOT NULL;
    