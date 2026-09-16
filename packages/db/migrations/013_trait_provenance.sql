-- Record which bag each trait came from.
--
-- The traits table had no provenance, so nothing could tell a trait belonging
-- to an installed bag from one left behind by a bag that was removed or
-- renamed. `ensureTraits` only ever inserts and updates; it never deletes, and
-- its caller flattens away the owning bag before the rows reach the DB. Rows
-- therefore accumulated across the pack->bag rename and every uninstall, and
-- `GET /api/v1/traits` -- a bare `SELECT *` -- served all of them. The session
-- picker in BarrySessions consequently offered traits (figma, notion, vault,
-- mobile-mcp, ...) with no backing bag, which resolve to zero tools.
--
-- `bag` is nullable and that nullability is load-bearing:
--   NULL      = not bag-derived. User-authored traits (config import via
--               upsertTrait) and hand-written composites like `all`, `read`,
--               and `coding` bundle namespaces across several bags and have
--               no single owner. These must never be pruned.
--   non-NULL  = derived from that bag's manifest by ensureTraits. Prunable
--               once the bag is no longer installed.
--
-- Backfill deliberately leaves every existing row NULL rather than guessing an
-- owner from the name. Trait names do not reliably match bag names (a bag
-- contributes both `git` and `git-read`; `vantage-core` contributes `vantage`),
-- so inferring provenance here would mislabel rows and make the reconcile step
-- delete live traits. The next bag sync calls ensureTraits and stamps the
-- real owner, converting rows to non-NULL as they are legitimately re-synced;
-- anything still NULL afterwards is either user-authored or a genuine orphan,
-- which `barry bag doctor` reports rather than silently removing.

ALTER TABLE traits ADD COLUMN IF NOT EXISTS bag TEXT;

COMMENT ON COLUMN traits.bag IS
  'Bag this trait was derived from; NULL for user-authored or composite traits (never auto-pruned).';

-- Reconcile queries filter on this to find rows whose owning bag is gone.
CREATE INDEX IF NOT EXISTS idx_traits_bag ON traits (bag) WHERE bag IS NOT NULL;
