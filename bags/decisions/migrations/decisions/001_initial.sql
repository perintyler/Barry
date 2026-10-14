
      -- One row per ask, answered or failed. A failed ask is a fact about the
      -- model that was asked, not noise: an audit that only holds successes
      -- cannot answer "why did this session suddenly stop deciding".
      CREATE TABLE decisions (
        id           TEXT PRIMARY KEY,
        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        -- The ref that was asked for, and the model that actually served it —
        -- an alias (von-latest) and a pin (von-1.3.0) are different facts.
        ref          TEXT NOT NULL,
        served_model TEXT,
        state        TEXT NOT NULL,
        state_truncated INTEGER NOT NULL DEFAULT 0,
        questions    TEXT NOT NULL,
        -- JSON answers, or NULL when the ask failed.
        answers      TEXT,
        usage        TEXT,
        duration_ms  INTEGER NOT NULL,
        error        TEXT
      );
      CREATE INDEX idx_decisions_created ON decisions (created_at);
      CREATE INDEX idx_decisions_ref ON decisions (ref);
    