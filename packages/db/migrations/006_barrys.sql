-- Rename profiles → barrys.
--
-- "Profile" was the old name for an agent identity; the concept is now a
-- Barry everywhere else (the CLI, the app, barry.yaml on disk). This is the
-- last layer still using the old vocabulary.
--
-- Postgres carries indexes and foreign-key constraints through a table rename
-- automatically, so only the constraint/index *names* need explicit updates —
-- they'd otherwise keep referring to a table that no longer exists.

ALTER TABLE profiles RENAME TO barrys;
ALTER TABLE sessions RENAME COLUMN profile_id TO barry_id;

-- Indexes (names only; the underlying definitions followed the rename)
ALTER INDEX IF EXISTS idx_profiles_actor_name RENAME TO idx_barrys_actor_name;
ALTER INDEX IF EXISTS idx_profiles_parent_id RENAME TO idx_barrys_parent_id;
ALTER INDEX IF EXISTS idx_sessions_profile_id RENAME TO idx_sessions_barry_id;

-- Primary key. `id` is an identity column, so there's no standalone sequence
-- to rename — Postgres keeps the implicit one attached through the rename.
ALTER INDEX IF EXISTS profiles_pkey RENAME TO barrys_pkey;

-- The active-Barry setting moved key with the rename. Migrate it rather than
-- letting it silently reset: a reader looking for `defaultBarry` on an
-- un-migrated row finds nothing and reports no active Barry.
UPDATE actors
SET settings = (settings - 'defaultProfile') || jsonb_build_object('defaultBarry', settings->'defaultProfile')
WHERE settings ? 'defaultProfile'
  AND NOT settings ? 'defaultBarry';

-- Drop the old key where both somehow exist (a switch ran pre-migration).
UPDATE actors
SET settings = settings - 'defaultProfile'
WHERE settings ? 'defaultProfile' AND settings ? 'defaultBarry';

-- Constraints carried over from the old table name
ALTER TABLE barrys RENAME CONSTRAINT profiles_token_key TO barrys_token_key;
ALTER TABLE barrys RENAME CONSTRAINT profiles_actor_id_name_key TO barrys_actor_id_name_key;
ALTER TABLE barrys RENAME CONSTRAINT profiles_actor_id_fkey TO barrys_actor_id_fkey;
ALTER TABLE barrys RENAME CONSTRAINT profiles_parent_id_fkey TO barrys_parent_id_fkey;
ALTER TABLE sessions RENAME CONSTRAINT sessions_profile_id_fkey TO sessions_barry_id_fkey;
