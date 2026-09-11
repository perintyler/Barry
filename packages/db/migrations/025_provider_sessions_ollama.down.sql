-- Revert to the pre-ollama provider list.
--
-- Rows with provider = 'ollama' would violate the narrowed constraint, so drop
-- them first: a local-model session has no meaning once the provider is gone,
-- and leaving them makes the migration fail rather than roll back.
DELETE FROM provider_sessions WHERE provider = 'ollama';

ALTER TABLE provider_sessions DROP CONSTRAINT IF EXISTS provider_sessions_provider_check;
ALTER TABLE provider_sessions ADD CONSTRAINT provider_sessions_provider_check
  CHECK (provider = ANY (ARRAY['claude'::text, 'codex'::text, 'opencode'::text, 'cursor'::text, 'zai'::text]));
