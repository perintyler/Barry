-- Rename the Scope primitive to Bound in persisted state.
--
-- Scope is the deny-half of the permission model: traits grant, scopes take
-- away. The name collides with too much — OAuth scope strings, the settings
-- tier discriminator, and ordinary lexical "scope" — so the primitive becomes
-- Bound. Code, package, and file names were renamed in the preceding commits;
-- this moves the durable state.
--
-- WHY THIS MIGRATION IS MORE DANGEROUS THAN IT LOOKS. Bound resolution FAILS
-- OPEN: an unresolvable bound is treated as "no restrictions" (see
-- docs/bounds.md). So a half-applied rename does not throw — it silently
-- produces sessions that look restricted and are not. Every step below is
-- idempotent and guarded so a partial application cannot leave that state.
--
-- NOT TOUCHED, DELIBERATELY: the `settings` table's own `scope` / `scope_id`
-- columns (001_baseline.sql:127-128) and their two indexes. Those are a
-- settings TIER discriminator ("global"/"session"), an entirely different
-- concept that merely shares the word. Renaming them here would break the
-- settings layer for no reason.

-- 1. Table -----------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scopes')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bounds')
  THEN
    ALTER TABLE scopes RENAME TO bounds;
  END IF;
END $$;

-- The JSONB payload column inside the table shares the old primitive's name.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bounds' AND column_name = 'scope'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bounds' AND column_name = 'bound'
  ) THEN
    ALTER TABLE bounds RENAME COLUMN scope TO bound;
  END IF;
END $$;

-- 2. Referencing columns ---------------------------------------------------
-- sessions.scope_id lost its FK in 016_session_agent_token (it was ON DELETE
-- SET NULL, so it never guaranteed integrity anyway) — there is no constraint
-- left to rename on it, only the column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'scope_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'bound_id'
  ) THEN
    ALTER TABLE sessions RENAME COLUMN scope_id TO bound_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'scope'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'bound'
  ) THEN
    ALTER TABLE sessions RENAME COLUMN scope TO bound;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'traits' AND column_name = 'scope'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'traits' AND column_name = 'bound'
  ) THEN
    ALTER TABLE traits RENAME COLUMN scope TO bound;
  END IF;
END $$;

-- 3. Index and constraint NAMES --------------------------------------------
-- Postgres carries indexes and constraints through a table rename, but their
-- names keep referring to a table that no longer exists. Renaming the table
-- without these leaves `scopes_pkey` on `bounds` — cosmetically wrong, and
-- confusing in every error message that quotes a constraint name.
ALTER INDEX IF EXISTS scopes_pkey RENAME TO bounds_pkey;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scopes_token_key') THEN
    ALTER TABLE bounds RENAME CONSTRAINT scopes_token_key TO bounds_token_key;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scopes_name_key') THEN
    ALTER TABLE bounds RENAME CONSTRAINT scopes_name_key TO bounds_name_key;
  END IF;
END $$;

COMMENT ON TABLE bounds IS
  'Named restrictions on agent capability. Bounds only ever deny — they cannot grant what a trait did not.';
COMMENT ON COLUMN bounds.bound IS
  'The AgentBound payload: deniedTools, deniedAccess, files.deny, bash.deny/denyPrograms, network.*';

-- 4. JSONB keys ------------------------------------------------------------
-- THE PART NO DDL REACHES, AND THE REASON THIS MIGRATION EXISTS AT ALL.
--
-- ALTER TABLE cannot rename a key inside a JSONB blob. Three such keys carry
-- the old vocabulary, and each one degrades SILENTLY when missed:
--
--   traits.metadata->'scopeNames'      read at packages/db/src/traits.ts
--                                      parseJsonArray -> [] on a missing key.
--                                      LOGS NOTHING AT ALL. A trait quietly
--                                      loses its restrictions. This is how the
--                                      builtin `read` trait once lost
--                                      [readonly] and left `barry start -r`
--                                      holding native Bash/Write/Edit.
--   identities.metadata->'scope_id'    packages/db/src/identities.ts
--                                      typeof === "number" -> undefined
--   identities.metadata->'scope'       packages/db/src/identities.ts
--                                      -> undefined
--
-- Each rewrite is key-by-key (not a wholesale metadata replace) so unrelated
-- keys and their ordering survive, and each is guarded against the
-- both-keys-present race — a writer that ran between the code deploy and this
-- migration would otherwise leave the stale key behind to win later.

-- 4a. traits.metadata->'scopeNames' -> 'boundNames'
UPDATE traits
SET metadata = (metadata - 'scopeNames') || jsonb_build_object('boundNames', metadata -> 'scopeNames')
WHERE metadata ? 'scopeNames'
  AND NOT metadata ? 'boundNames';

UPDATE traits
SET metadata = metadata - 'scopeNames'
WHERE metadata ? 'scopeNames'
  AND metadata ? 'boundNames';

-- 4b. identities.metadata->'scope_id' -> 'bound_id'
UPDATE identities
SET metadata = (metadata - 'scope_id') || jsonb_build_object('bound_id', metadata -> 'scope_id')
WHERE metadata ? 'scope_id'
  AND NOT metadata ? 'bound_id';

UPDATE identities
SET metadata = metadata - 'scope_id'
WHERE metadata ? 'scope_id'
  AND metadata ? 'bound_id';

-- 4c. identities.metadata->'scope' -> 'bound'
UPDATE identities
SET metadata = (metadata - 'scope') || jsonb_build_object('bound', metadata -> 'scope')
WHERE metadata ? 'scope'
  AND NOT metadata ? 'bound';

UPDATE identities
SET metadata = metadata - 'scope'
WHERE metadata ? 'scope'
  AND metadata ? 'bound';
