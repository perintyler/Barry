-- Add 'zai' to the provider_sessions CHECK constraint.
--
-- The provider list is enumerated in seven places. `ProviderIdSchema`
-- (contracts), `ProviderId`/`Provider` (agent-runtime) and three checks in
-- sdk-manager carry zai; this constraint and two other call sites never got
-- it. So a zai session reaches _createProviderSession and dies on
-- provider_sessions_provider_check — the session starts, then cannot record
-- the provider_session_id that `barry resume` needs.
--
-- Not converted to an FK against providers(key) here. That table now exists
-- (migration 020) and is the eventual home for this list, but provider_sessions
-- deliberately has zero outbound FKs (migration 016 removed them so the session
-- bag could own its schema); re-adding one would undo that. The CHECK stays the
-- enforcement point until the bag's ownership question is settled.

ALTER TABLE provider_sessions DROP CONSTRAINT IF EXISTS provider_sessions_provider_check;
ALTER TABLE provider_sessions ADD CONSTRAINT provider_sessions_provider_check
  CHECK (provider = ANY (ARRAY['claude'::text, 'codex'::text, 'opencode'::text, 'cursor'::text, 'zai'::text]));
