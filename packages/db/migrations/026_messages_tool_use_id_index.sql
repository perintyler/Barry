-- Index the tool-call correlation lookup by toolUseId.
--
-- Tool-result persistence falls back to
-- `metadata::text LIKE '%<toolUseId>%'` when no in-process pending-call map
-- entry exists (packages/db/src/messages.ts). That is an unindexed full-text
-- scan, and it is also a correctness bug: a subagent's tool_call row carries
-- `metadata.parentToolUseId` set to the PARENT's toolUseId, which is a
-- substring match for the LIKE pattern. Ordered `sequence DESC`, the fallback
-- can attach a parent's result to the wrong (child) row.
--
-- The astra performance review observed a live index named
-- `idx_messages_tool_calls` and warned not to recreate it because it
-- "exists" — it does exist (`btree (type, created_at DESC, name,
-- session_id)`), but it is shaped for the reporting/leaderboard queries in
-- the metrics bag, not for toolUseId lookup, and no migration in this
-- directory ever created it (drift between the live database and the
-- migration history). This is the toolUseId index's first real migration.
--
-- Plain CREATE INDEX, not CONCURRENTLY: this repo's migration runner wraps
-- every migration in one transaction (src/migrate.ts, `sql.begin(...)`), and
-- Postgres refuses CREATE INDEX CONCURRENTLY inside a transaction block. A
-- partial index on a JSONB expression over the current message volume is a
-- lock measured in seconds, not the kind of build CONCURRENTLY exists for.

CREATE INDEX IF NOT EXISTS idx_messages_tool_use_id
  ON messages (session_id, (metadata->>'toolUseId'))
  WHERE type = 'tool_call';
