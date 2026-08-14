-- Rename the "block" vocabulary to "bag" in persisted state.
--
-- The Barry Blocks concept became Barry Bags. Code, paths, manifests and
-- launchd labels were renamed in the same change; this migration moves the two
-- places the old word was durably stored in Postgres.
--
-- 1. traits.block -> traits.bag
--    Added by 013_trait_provenance as `block`. That file's text was rewritten
--    to say `bag` for the benefit of fresh databases, but any database that
--    already ran 013 still has the old column name, so it is renamed here.
--    IF EXISTS on both sides makes this safe in either order.
--
-- 2. identities.metadata->>'blocks' -> identities.metadata->>'bags'
--    The enabled-bag list lives in a JSONB blob, so no DDL reaches it. Rows are
--    rewritten key-by-key rather than wholesale so unrelated metadata keys and
--    their ordering survive untouched.
--
-- Both steps are idempotent: re-running finds nothing left to rename.

-- 1. Column ---------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'traits' AND column_name = 'block'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'traits' AND column_name = 'bag'
  ) THEN
    ALTER TABLE traits RENAME COLUMN block TO bag;
  END IF;
END $$;

-- The index came along with the column but kept its old name.
ALTER INDEX IF EXISTS idx_traits_block RENAME TO idx_traits_bag;

COMMENT ON COLUMN traits.bag IS
  'Bag this trait was derived from; NULL for user-authored or composite traits (never auto-pruned).';

-- 1b. action_runs.block -> action_runs.bag --------------------------------
-- Added by 011_action_runs as `block` (NOT NULL). Same situation as traits:
-- 011's text now reads `bag` for fresh databases, so existing ones rename here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'action_runs' AND column_name = 'block'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'action_runs' AND column_name = 'bag'
  ) THEN
    ALTER TABLE action_runs RENAME COLUMN block TO bag;
  END IF;
END $$;

-- 2. JSONB key ------------------------------------------------------------
-- `- 'blocks'` drops the old key; jsonb_build_object re-adds it as `bags`.
-- Guarded so rows already carrying `bags` are left alone.
UPDATE identities
SET metadata = (metadata - 'blocks') || jsonb_build_object('bags', metadata -> 'blocks')
WHERE metadata ? 'blocks'
  AND NOT metadata ? 'bags';

-- Rows that somehow carry BOTH keys: keep `bags`, drop the stale `blocks`.
UPDATE identities
SET metadata = metadata - 'blocks'
WHERE metadata ? 'blocks'
  AND metadata ? 'bags';
