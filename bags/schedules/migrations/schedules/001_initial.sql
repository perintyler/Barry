
      -- One row per schedule the scheduler has seen, keyed <bag>/<name>.
      CREATE TABLE schedule_state (
        schedule_id TEXT PRIMARY KEY,
        -- When the scheduler last started a run for it (ISO text).
        last_fired_at TEXT,
        -- When it is next due. Persisted so a fire missed while the scheduler
        -- was down is visible on restart instead of silently recomputed away.
        next_fire_at TEXT,
        -- The trigger next_fire_at was computed from. When the bag.yaml
        -- changes the trigger, the stored due time belongs to the old one and
        -- is recomputed instead of honoured.
        trigger_key TEXT,
        paused INTEGER NOT NULL DEFAULT 0,
        last_run_id TEXT,
        last_status TEXT,
        -- What the last fire reported. For a fire that could not start there
        -- is no run row to hold the reason, so this is the only place it lives.
        last_summary TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        -- 1 once the current failure streak has been announced. A failure
        -- that could not be announced (API down) stays 0 and is retried,
        -- rather than being lost the way a one-shot POST would lose it.
        failure_announced INTEGER NOT NULL DEFAULT 0,
        -- Fires that landed while the previous run was still going.
        skipped_fires INTEGER NOT NULL DEFAULT 0,
        -- Fires missed while nothing was running and not caught up.
        missed_fires INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      -- Schedules created at runtime (MCP, CLI, API) rather than in a bag.
      -- They live under the pseudo-bag "runtime": runtime/<name>.
      CREATE TABLE runtime_schedules (
        name TEXT PRIMARY KEY,
        -- The schedule exactly as a bag.yaml would declare it, as JSON, and
        -- parsed by the same schema — one grammar for both.
        spec TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT
      );

      -- The scheduler's proof of life, read by the API's watchdog.
      CREATE TABLE heartbeat (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        at TEXT NOT NULL,
        pid INTEGER NOT NULL,
        schedules INTEGER NOT NULL,
        load_errors TEXT NOT NULL DEFAULT '[]'
      );
    