-- Revert 028_bounds.sql: bounds -> scopes.
--
-- Exact mirror, same idempotent guards, same key-by-key JSONB rewrites with
-- the both-keys-present race handled. Written because a rename that cannot be
-- rolled back is a one-way door, and this one sits in the permission layer.

-- 4. JSONB keys (reversed first, so the columns they describe still exist) --
UPDATE identities
SET metadata = (metadata - 'bound') || jsonb_build_object('scope', metadata -> 'bound')
WHERE metadata ? 'bound'
  AND NOT metadata ? 'scope';

UPDATE identities
SET metadata = metadata - 'bound'
WHERE metadata ? 'bound'
  AND metadata ? 'scope';

UPDATE identities
SET metadata = (metadata - 'bound_id') || jsonb_build_object('scope_id', metadata -> 'bound_id')
WHERE metadata ? 'bound_id'
  AND NOT metadata ? 'scope_id';

UPDATE identities
SET metadata = metadata - 'bound_id'
WHERE metadata ? 'bound_id'
  AND metadata ? 'scope_id';

UPDATE traits
SET metadata = (metadata - 'boundNames') || jsonb_build_object('scopeNames', metadata -> 'boundNames')
WHERE metadata ? 'boundNames'
  AND NOT metadata ? 'scopeNames';

UPDATE traits
SET metadata = metadata - 'boundNames'
WHERE metadata ? 'boundNames'
  AND metadata ? 'scopeNames';

-- 3. Index and constraint names --------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bounds_token_key') THEN
    ALTER TABLE bounds RENAME CONSTRAINT bounds_token_key TO scopes_token_key;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bounds_name_key') THEN
    ALTER TABLE bounds RENAME CONSTRAINT bounds_name_key TO scopes_name_key;
  END IF;
END $$;

ALTER INDEX IF EXISTS bounds_pkey RENAME TO scopes_pkey;

-- 2. Referencing columns ---------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'traits' AND column_name = 'bound'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'traits' AND column_name = 'scope'
  ) THEN
    ALTER TABLE traits RENAME COLUMN bound TO scope;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'bound'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'scope'
  ) THEN
    ALTER TABLE sessions RENAME COLUMN bound TO scope;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'bound_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'scope_id'
  ) THEN
    ALTER TABLE sessions RENAME COLUMN bound_id TO scope_id;
  END IF;
END $$;

-- 1. Table -----------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bounds' AND column_name = 'bound'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bounds' AND column_name = 'scope'
  ) THEN
    ALTER TABLE bounds RENAME COLUMN bound TO scope;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'bounds')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scopes')
  THEN
    ALTER TABLE bounds RENAME TO scopes;
  END IF;
END $$;
