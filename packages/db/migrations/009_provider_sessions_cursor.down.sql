-- Rollback 009: drop 'cursor' from the allowed provider_sessions providers.
--
-- Rows naming the provider being removed have to go first, or the re-added
-- constraint fails to validate against existing data. That means rolling back
-- discards Cursor sessions' resume pointers — which is the honest consequence
-- of narrowing the column back to a set those rows are not part of.

DELETE FROM provider_sessions WHERE provider = 'cursor';

ALTER TABLE provider_sessions DROP CONSTRAINT IF EXISTS provider_sessions_provider_check;
ALTER TABLE provider_sessions
  ADD CONSTRAINT provider_sessions_provider_check
  CHECK (provider = ANY (ARRAY['claude'::text, 'codex'::text, 'opencode'::text]));
