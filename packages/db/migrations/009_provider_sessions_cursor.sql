-- Allow 'cursor' as a provider_sessions provider.
--
-- The cursor provider shipped in 4e8356e6 (agent-runtime, cli, sdk-manager,
-- profile plumbing) but this CHECK constraint was never widened, so every
-- insert naming it failed with:
--
--   new row for relation "provider_sessions" violates check constraint
--   "provider_sessions_provider_check"
--
-- The SessionStart hook swallows write errors so it can never block the agent,
-- so the failure was silent. The damage was not limited to Cursor: the same
-- commit switched the hook from a hardcoded provider: "claude" to the value
-- normalizeHookInput derives, and that helper treats the presence of
-- hook_event_name as a Cursor signal. Claude Code sends hook_event_name on
-- every hook payload, so ordinary Claude sessions were labelled 'cursor' and
-- hit this constraint too -- which is why provider_sessions has no rows at all
-- after 2026-07-24 and `barry resume <id>` had nothing to resume against.
--
-- The misclassification is fixed in hooks/session-tracker/src/normalize.ts.
-- This migration fixes the other half: 'cursor' is a real provider and belongs
-- in the allowed set alongside the rest.

ALTER TABLE provider_sessions DROP CONSTRAINT IF EXISTS provider_sessions_provider_check;
ALTER TABLE provider_sessions
  ADD CONSTRAINT provider_sessions_provider_check
  CHECK (provider = ANY (ARRAY['claude'::text, 'codex'::text, 'opencode'::text, 'cursor'::text]));
