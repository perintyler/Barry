-- Stage 5 of the session storage extraction: decouple sessions from the actors
-- table by replacing agent_id (an internal FK) with agent_token (a stable,
-- cross-machine-portable text identifier). Also drop the user_id, profile_id,
-- and scope_id FKs — these were SET NULL on delete, meaning they already did
-- not guarantee referential integrity for the session bag. The integer values
-- are preserved as denormalized data; only the constraints are removed.
--
-- After this migration, sessions/messages/provider_sessions have ZERO outbound
-- FKs to other tables. All inbound FKs (artifacts, events, action_runs) are
-- already ON DELETE SET NULL. The session bag can own this schema.

-- 1. Add the agent_token column (nullable during backfill)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_token TEXT;

-- 2. Backfill from actors.token
UPDATE sessions
SET agent_token = actors.token
FROM actors
WHERE sessions.agent_id = actors.id
  AND sessions.agent_token IS NULL;

-- 3. Default any orphans (agent_id pointing at a deleted actor — shouldn't
--    exist due to RESTRICT, but be safe)
UPDATE sessions
SET agent_token = 'agent-unknown'
WHERE agent_token IS NULL;

-- 4. Make NOT NULL
ALTER TABLE sessions ALTER COLUMN agent_token SET NOT NULL;

-- 5. Drop outbound FKs. The constraint names come from Postgres's auto-naming
--    convention (tablename_columnname_fkey) used in 001_baseline.sql.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_agent_id_fkey;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_id_fkey;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_profile_id_fkey;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_scope_id_fkey;

-- 6. Drop agent_id column (its information is now in agent_token)
ALTER TABLE sessions DROP COLUMN IF EXISTS agent_id;
