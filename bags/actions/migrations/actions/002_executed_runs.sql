
      ALTER TABLE action_runs ADD COLUMN trigger TEXT;
      ALTER TABLE action_runs ADD COLUMN schedule_id TEXT;
      ALTER TABLE action_runs ADD COLUMN exit_code INTEGER;
      ALTER TABLE action_runs ADD COLUMN duration_ms INTEGER;
      ALTER TABLE action_runs ADD COLUMN log_path TEXT;

      CREATE INDEX idx_action_runs_schedule ON action_runs(schedule_id, started_at DESC)
        WHERE schedule_id IS NOT NULL;
    