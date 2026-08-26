-- Restore the four-provider constraint. Any zai rows written meanwhile would
-- violate it, so drop them first — they are resume pointers, not user data.
DELETE FROM provider_sessions WHERE provider = 'zai';
ALTER TABLE provider_sessions DROP CONSTRAINT IF EXISTS provider_sessions_provider_check;
ALTER TABLE provider_sessions ADD CONSTRAINT provider_sessions_provider_check
  CHECK (provider = ANY (ARRAY['claude'::text, 'codex'::text, 'opencode'::text, 'cursor'::text]));
