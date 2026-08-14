-- Drop trait provenance. The column is additive and nothing outside the
-- reconcile path reads it, so removing it only loses the ability to tell
-- bag-derived traits from user-authored ones -- the pre-migration state.
DROP INDEX IF EXISTS idx_traits_bag;
ALTER TABLE traits DROP COLUMN IF EXISTS bag;
