      ALTER TABLE adhoc_actions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

      CREATE TABLE IF NOT EXISTS adhoc_action_outbox (
        id TEXT PRIMARY KEY,
        owner_session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        definition TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        artifact_id TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_adhoc_action_outbox_pending
        ON adhoc_action_outbox (status, created_at);
