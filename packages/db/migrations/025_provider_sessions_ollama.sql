-- Add 'ollama' to the provider_sessions CHECK constraint.
--
-- Migration 021 said the provider list was "enumerated in seven places" and
-- that zai was missed in three of them, so a zai session started and then died
-- here on provider_sessions_provider_check — unable to record the
-- provider_session_id that `barry resume` needs.
--
-- That count is now smaller, and the remaining sites are guarded. The CLI's
-- provider ternary (copied to four call sites, each omitting zai) is one
-- `resolveLaunchProvider`; `ProviderIdSchema` is the single root the runtime
-- types and point-guard derive from; and models.test.ts now parses THIS
-- constraint and fails when it drifts from that enum. This file is the one
-- place a value list still has to be written by hand.
--
-- Still not an FK against providers(key): that table exists (migration 020),
-- but provider_sessions deliberately has zero outbound FKs (migration 016
-- removed them so the session bag could own its schema). The CHECK stays the
-- enforcement point until that ownership question is settled.

ALTER TABLE provider_sessions DROP CONSTRAINT IF EXISTS provider_sessions_provider_check;
ALTER TABLE provider_sessions ADD CONSTRAINT provider_sessions_provider_check
  CHECK (provider = ANY (ARRAY['claude'::text, 'codex'::text, 'opencode'::text, 'cursor'::text, 'zai'::text, 'ollama'::text]));
