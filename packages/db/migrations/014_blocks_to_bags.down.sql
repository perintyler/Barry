-- Reverse the bag vocabulary rename in persisted state.
--
-- Restores `traits.block` and `identities.metadata->'blocks'`. Only useful
-- alongside a code rollback to a pre-bags build, since current code reads the
-- `bag` names exclusively.

-- 1. Column ---------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'traits' AND column_name = 'bag'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'traits' AND column_name = 'block'
  ) THEN
    ALTER TABLE traits RENAME COLUMN bag TO block;
  END IF;
END $$;

ALTER INDEX IF EXISTS idx_traits_bag RENAME TO idx_traits_block;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'action_runs' AND column_name = 'bag'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'action_runs' AND column_name = 'block'
  ) THEN
    ALTER TABLE action_runs RENAME COLUMN bag TO block;
  END IF;
END $$;

COMMENT ON COLUMN traits.block IS
  'Block this trait was derived from; NULL for user-authored or composite traits (never auto-pruned).';

-- 2. JSONB key ------------------------------------------------------------
UPDATE identities
SET metadata = (metadata - 'bags') || jsonb_build_object('blocks', metadata -> 'bags')
WHERE metadata ? 'bags'
  AND NOT metadata ? 'blocks';

UPDATE identities
SET metadata = metadata - 'bags'
WHERE metadata ? 'bags'
  AND metadata ? 'blocks';
