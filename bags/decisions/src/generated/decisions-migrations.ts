// Generated from SQL migrations. Run pnpm stores:generate; do not edit.
export default [
  {
    "name": "001_initial.sql",
    "sql": "\n      -- One row per ask, answered or failed. A failed ask is a fact about the\n      -- model that was asked, not noise: an audit that only holds successes\n      -- cannot answer \"why did this session suddenly stop deciding\".\n      CREATE TABLE decisions (\n        id           TEXT PRIMARY KEY,\n        created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),\n        -- The ref that was asked for, and the model that actually served it —\n        -- an alias (von-latest) and a pin (von-1.3.0) are different facts.\n        ref          TEXT NOT NULL,\n        served_model TEXT,\n        state        TEXT NOT NULL,\n        state_truncated INTEGER NOT NULL DEFAULT 0,\n        questions    TEXT NOT NULL,\n        -- JSON answers, or NULL when the ask failed.\n        answers      TEXT,\n        usage        TEXT,\n        duration_ms  INTEGER NOT NULL,\n        error        TEXT\n      );\n      CREATE INDEX idx_decisions_created ON decisions (created_at);\n      CREATE INDEX idx_decisions_ref ON decisions (ref);\n    "
  }
];
