-- Stop provider_sessions from accumulating duplicate rows.
--
-- The SessionStart hook fires on every session start, resume, and restart, and
-- createProviderSession inserts unconditionally. Resuming the same session ten
-- times therefore wrote ten identical rows. Some sessions carry nine.
--
-- The rows are harmless to reads (getProviderSessionsBySession orders by
-- created_at DESC and resume takes the first match, and the duplicates all name
-- the same conversation) but they make the table's meaning ambiguous: it is
-- impossible to tell "resumed nine times" from "nine different conversations"
-- without comparing provider_session_id values.
--
-- IMPORTANT: only EXACT (session_id, provider, provider_session_id) repeats are
-- collapsed. A session that genuinely mapped to several different conversations
-- — e.g. `--continue` starting a new conversation under one Barry session —
-- keeps every distinct pointer. Nine such sessions exist and must survive.

-- Keep the oldest row of each exact triple: created_at is the honest record of
-- when the link was first established, and endProviderSessionByProviderId
-- targets provider_session_id rather than a specific row id, so which row
-- survives does not change end-of-session behaviour.
DELETE FROM provider_sessions ps
USING provider_sessions keep
WHERE ps.session_id = keep.session_id
  AND ps.provider = keep.provider
  AND ps.provider_session_id IS NOT DISTINCT FROM keep.provider_session_id
  AND ps.id > keep.id;

-- Enforce it going forward. Partial, because provider_session_id is nullable
-- and NULLs are not duplicates of each other in any meaningful sense: a row
-- awaiting its provider id must not collide with another in the same state.
CREATE UNIQUE INDEX IF NOT EXISTS provider_sessions_unique_link
  ON provider_sessions (session_id, provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;
