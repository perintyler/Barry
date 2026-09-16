-- Reverse 011_identities.sql: identities → barrys.

ALTER TABLE identities RENAME TO barrys;
ALTER TABLE sessions RENAME COLUMN identity_id TO barry_id;

ALTER INDEX IF EXISTS idx_identities_actor_name RENAME TO idx_barrys_actor_name;
ALTER INDEX IF EXISTS idx_sessions_identity_id RENAME TO idx_sessions_barry_id;

ALTER INDEX IF EXISTS identities_pkey RENAME TO barrys_pkey;

ALTER TABLE barrys RENAME CONSTRAINT identities_token_key TO barrys_token_key;
ALTER TABLE barrys RENAME CONSTRAINT identities_actor_id_name_key TO barrys_actor_id_name_key;
ALTER TABLE barrys RENAME CONSTRAINT identities_actor_id_fkey TO barrys_actor_id_fkey;
ALTER TABLE sessions RENAME CONSTRAINT sessions_identity_id_fkey TO sessions_barry_id_fkey;

-- `actors.settings.defaultBarry` was never renamed, so there is nothing to
-- restore here.
