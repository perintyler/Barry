-- Rename barrys → identities.
--
-- "Barry" collided with the product name: `~/.barry` is the install root while
-- `~/.barry/barrys/` was the entity collection, and `getBarryDir()` (one
-- entity) sat one letter from `getBarryHome()` (the whole install). The entity
-- is an agent identity — bags, traits, model defaults, secrets, scopes that a
-- session inherits — so `identities` names it without borrowing the product
-- word.
--
-- Postgres carries indexes and foreign-key constraints through a table rename
-- automatically, so only the constraint/index *names* need explicit updates —
-- they'd otherwise keep referring to a table that no longer exists.

ALTER TABLE barrys RENAME TO identities;
ALTER TABLE sessions RENAME COLUMN barry_id TO identity_id;

-- Indexes (names only; the underlying definitions followed the rename)
-- (`idx_barrys_parent_id` is intentionally absent: migration 007 dropped
-- `parent_id` along with barry inheritance.)
ALTER INDEX IF EXISTS idx_barrys_actor_name RENAME TO idx_identities_actor_name;
ALTER INDEX IF EXISTS idx_sessions_barry_id RENAME TO idx_sessions_identity_id;

-- Primary key. `id` is an identity column, so there's no standalone sequence
-- to rename — Postgres keeps the implicit one attached through the rename.
ALTER INDEX IF EXISTS barrys_pkey RENAME TO identities_pkey;

-- Constraints carried over from the old table name.
ALTER TABLE identities RENAME CONSTRAINT barrys_token_key TO identities_token_key;
ALTER TABLE identities RENAME CONSTRAINT barrys_actor_id_name_key TO identities_actor_id_name_key;
ALTER TABLE identities RENAME CONSTRAINT barrys_actor_id_fkey TO identities_actor_id_fkey;
ALTER TABLE sessions RENAME CONSTRAINT sessions_barry_id_fkey TO sessions_identity_id_fkey;

-- Deliberately NOT migrated: `actors.settings.defaultBarry`.
--
-- Migration 006 moved `defaultProfile` → `defaultBarry` because the old key was
-- purely internal. This one is not: it round-trips through the user-facing
-- `settings.yaml` that `barry config export` writes and `import` reads back, so
-- renaming it is a file-format change rather than a rename. "Active" is already
-- the user-facing word for it. See cli/src/lib/current-user.ts.
