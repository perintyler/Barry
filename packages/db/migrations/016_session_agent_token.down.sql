-- Reverse the agent_token migration. This re-adds agent_id as a non-FK column
-- (the actor rows may no longer exist), backfills from agent_token → actors.token,
-- then re-adds the FKs. Lossy: any session whose actor was deleted gets agent_id=1.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_id INTEGER;

UPDATE sessions
SET agent_id = actors.id
FROM actors
WHERE sessions.agent_token = actors.token
  AND sessions.agent_id IS NULL;

-- Fallback for orphaned tokens
UPDATE sessions SET agent_id = 1 WHERE agent_id IS NULL;

ALTER TABLE sessions ALTER COLUMN agent_id SET NOT NULL;

-- Re-add FKs
ALTER TABLE sessions ADD CONSTRAINT sessions_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES actors(id) ON DELETE RESTRICT;
ALTER TABLE sessions ADD CONSTRAINT sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES actors(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD CONSTRAINT sessions_profile_id_fkey
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD CONSTRAINT sessions_scope_id_fkey
  FOREIGN KEY (scope_id) REFERENCES scopes(id) ON DELETE SET NULL;

ALTER TABLE sessions DROP COLUMN IF EXISTS agent_token;
