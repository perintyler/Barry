// Generated from SQL migrations. Run pnpm stores:generate; do not edit.
export default [
  {
    "name": "001_initial.sql",
    "sql": "\n      -- One row per schedule the scheduler has seen, keyed <bag>/<name>.\n      CREATE TABLE schedule_state (\n        schedule_id TEXT PRIMARY KEY,\n        -- When the scheduler last started a run for it (ISO text).\n        last_fired_at TEXT,\n        -- When it is next due. Persisted so a fire missed while the scheduler\n        -- was down is visible on restart instead of silently recomputed away.\n        next_fire_at TEXT,\n        -- The trigger next_fire_at was computed from. When the bag.yaml\n        -- changes the trigger, the stored due time belongs to the old one and\n        -- is recomputed instead of honoured.\n        trigger_key TEXT,\n        paused INTEGER NOT NULL DEFAULT 0,\n        last_run_id TEXT,\n        last_status TEXT,\n        -- What the last fire reported. For a fire that could not start there\n        -- is no run row to hold the reason, so this is the only place it lives.\n        last_summary TEXT,\n        consecutive_failures INTEGER NOT NULL DEFAULT 0,\n        -- 1 once the current failure streak has been announced. A failure\n        -- that could not be announced (API down) stays 0 and is retried,\n        -- rather than being lost the way a one-shot POST would lose it.\n        failure_announced INTEGER NOT NULL DEFAULT 0,\n        -- Fires that landed while the previous run was still going.\n        skipped_fires INTEGER NOT NULL DEFAULT 0,\n        -- Fires missed while nothing was running and not caught up.\n        missed_fires INTEGER NOT NULL DEFAULT 0,\n        updated_at TEXT NOT NULL\n      );\n\n      -- Schedules created at runtime (MCP, CLI, API) rather than in a bag.\n      -- They live under the pseudo-bag \"runtime\": runtime/<name>.\n      CREATE TABLE runtime_schedules (\n        name TEXT PRIMARY KEY,\n        -- The schedule exactly as a bag.yaml would declare it, as JSON, and\n        -- parsed by the same schema — one grammar for both.\n        spec TEXT NOT NULL,\n        created_at TEXT NOT NULL,\n        created_by TEXT\n      );\n\n      -- The scheduler's proof of life, read by the API's watchdog.\n      CREATE TABLE heartbeat (\n        id INTEGER PRIMARY KEY CHECK (id = 1),\n        at TEXT NOT NULL,\n        pid INTEGER NOT NULL,\n        schedules INTEGER NOT NULL,\n        load_errors TEXT NOT NULL DEFAULT '[]'\n      );\n    "
  },
  {
    "name": "002_one_offs.sql",
    "sql": "\n      CREATE TABLE one_off (\n        id               TEXT PRIMARY KEY,\n        -- The bag the action belongs to; idempotency keys are unique per bag.\n        bag              TEXT NOT NULL,\n        -- 'bag:name' for a catalog action, or NULL with inline_action set.\n        action           TEXT,\n        -- An inline action body (JSON) — only from trusted in-process callers\n        -- (MCP), never the HTTP API, which may name declared actions only.\n        inline_action    TEXT,\n        inputs_json      TEXT NOT NULL,\n        env              TEXT NOT NULL,\n        due_at           TEXT NOT NULL,\n        created_at       TEXT NOT NULL,\n        updated_at       TEXT NOT NULL,\n        status           TEXT NOT NULL,\n        reason           TEXT,\n        idempotency_key  TEXT,\n        request_hash     TEXT NOT NULL,\n        timeout_s        INTEGER NOT NULL,\n        retry_attempts   INTEGER NOT NULL,\n        failures         INTEGER NOT NULL DEFAULT 0,\n        recoveries       INTEGER NOT NULL DEFAULT 0,\n        created_by       TEXT,\n        UNIQUE (bag, idempotency_key)\n      );\n      CREATE INDEX idx_one_off_due ON one_off(status, due_at);\n\n      CREATE TABLE one_off_attempt (\n        id                TEXT PRIMARY KEY,\n        one_off_id        TEXT NOT NULL,\n        number            INTEGER NOT NULL,\n        -- The action run this attempt produced, once it exists.\n        run_id            TEXT,\n        started_at        TEXT NOT NULL,\n        finished_at       TEXT,\n        outcome           TEXT NOT NULL,\n        exit_code         INTEGER,\n        -- The scheduler process running the attempt, by identity (pid + start\n        -- time, since pids are reused), and the script's process group.\n        runner_pid        INTEGER NOT NULL,\n        runner_started_at INTEGER,\n        process_group     INTEGER\n      );\n      CREATE INDEX idx_one_off_attempt ON one_off_attempt(one_off_id, number);\n    "
  },
  {
    "name": "003_one_off_without_env.sql",
    "sql": "ALTER TABLE one_off DROP COLUMN env;"
  },
  {
    "name": "004_schedule_permissions.sql",
    "sql": "ALTER TABLE one_off ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}';"
  },
  {
    "name": "005_schedule_identity_id.sql",
    "sql": "ALTER TABLE runtime_schedules ADD COLUMN identity_id INTEGER;\nALTER TABLE one_off ADD COLUMN identity_id INTEGER;\n"
  },
  {
    "name": "006_login_event_claims.sql",
    "sql": "CREATE TABLE login_event_claims (\n  schedule_id TEXT NOT NULL,\n  event_id TEXT NOT NULL,\n  claimed_at TEXT NOT NULL,\n  PRIMARY KEY (schedule_id, event_id)\n) WITHOUT ROWID;\n"
  },
  {
    "name": "007_one_off_job.sql",
    "sql": "ALTER TABLE one_off ADD COLUMN job TEXT;\nALTER TABLE one_off ADD COLUMN caller_session_id TEXT;\nALTER TABLE one_off ADD COLUMN cancel_requested_at TEXT;\n"
  }
];
