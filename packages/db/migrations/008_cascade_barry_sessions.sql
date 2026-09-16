-- Deleting a Barry now deletes its sessions.
--
-- `sessions.barry_id` was ON DELETE SET NULL, which left sessions behind with
-- no Barry: no traits, no scope, no model, nothing to resume against. Every
-- table below sessions already cascades (messages, provider_sessions), so the
-- chain broke only at the top and each deleted Barry silently added dead rows.
--
-- Sessions are owned by their Barry, so the cascade matches how the data is
-- actually used. Deleting a Barry is already an explicit, confirmed action.

-- Existing orphans predate the cascade. They carry no messages — nothing
-- references them and nothing can resume them.
DELETE FROM sessions WHERE barry_id IS NULL;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_barry_id_fkey;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_barry_id_fkey
  FOREIGN KEY (barry_id) REFERENCES barrys(id) ON DELETE CASCADE;

-- events.session_id stays SET NULL on purpose: an event is a log of something
-- that happened, not part of the session's state, and keeping it after the
-- session goes away is the point of having it.
