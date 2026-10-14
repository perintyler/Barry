
      CREATE TABLE one_off (
        id               TEXT PRIMARY KEY,
        -- The bag the action belongs to; idempotency keys are unique per bag.
        bag              TEXT NOT NULL,
        -- 'bag:name' for a catalog action, or NULL with inline_action set.
        action           TEXT,
        -- An inline action body (JSON) — only from trusted in-process callers
        -- (MCP), never the HTTP API, which may name declared actions only.
        inline_action    TEXT,
        inputs_json      TEXT NOT NULL,
        env              TEXT NOT NULL,
        due_at           TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        status           TEXT NOT NULL,
        reason           TEXT,
        idempotency_key  TEXT,
        request_hash     TEXT NOT NULL,
        timeout_s        INTEGER NOT NULL,
        retry_attempts   INTEGER NOT NULL,
        failures         INTEGER NOT NULL DEFAULT 0,
        recoveries       INTEGER NOT NULL DEFAULT 0,
        created_by       TEXT,
        UNIQUE (bag, idempotency_key)
      );
      CREATE INDEX idx_one_off_due ON one_off(status, due_at);

      CREATE TABLE one_off_attempt (
        id                TEXT PRIMARY KEY,
        one_off_id        TEXT NOT NULL,
        number            INTEGER NOT NULL,
        -- The action run this attempt produced, once it exists.
        run_id            TEXT,
        started_at        TEXT NOT NULL,
        finished_at       TEXT,
        outcome           TEXT NOT NULL,
        exit_code         INTEGER,
        -- The scheduler process running the attempt, by identity (pid + start
        -- time, since pids are reused), and the script's process group.
        runner_pid        INTEGER NOT NULL,
        runner_started_at INTEGER,
        process_group     INTEGER
      );
      CREATE INDEX idx_one_off_attempt ON one_off_attempt(one_off_id, number);
    