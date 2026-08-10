-- Revert 006_barrys.sql: barrys → profiles.

ALTER TABLE barrys RENAME TO profiles;
ALTER TABLE sessions RENAME COLUMN barry_id TO profile_id;

ALTER INDEX IF EXISTS idx_barrys_actor_name RENAME TO idx_profiles_actor_name;
ALTER INDEX IF EXISTS idx_barrys_parent_id RENAME TO idx_profiles_parent_id;
ALTER INDEX IF EXISTS idx_sessions_barry_id RENAME TO idx_sessions_profile_id;
ALTER INDEX IF EXISTS barrys_pkey RENAME TO profiles_pkey;

ALTER TABLE profiles RENAME CONSTRAINT barrys_token_key TO profiles_token_key;
ALTER TABLE profiles RENAME CONSTRAINT barrys_actor_id_name_key TO profiles_actor_id_name_key;
ALTER TABLE profiles RENAME CONSTRAINT barrys_actor_id_fkey TO profiles_actor_id_fkey;
ALTER TABLE profiles RENAME CONSTRAINT barrys_parent_id_fkey TO profiles_parent_id_fkey;
ALTER TABLE sessions RENAME CONSTRAINT sessions_barry_id_fkey TO sessions_profile_id_fkey;
