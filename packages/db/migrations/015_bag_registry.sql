-- Move the bag registry from YAML into Postgres.
--
-- The registry (which bags exist and where they live) lived in two YAML files:
-- `config/bags.builtin.yaml` (shipped with the repo) overlaid by a user file at
-- ~/Library/Application Support/Barry/bags.yaml. Bag *membership* already lived
-- in Postgres (identities.metadata.bags, traits.bag), so the two had to agree
-- by convention — the drift `barry bag doctor` exists to detect.
--
-- Postgres is now authoritative for the registry. Sync readers (shell
-- completion, Commander group registration before program.parse(), and
-- per-firing hook dispatch) cannot await, so they read a generated snapshot
-- file instead; the snapshot is derived from this table, never hand-edited.
--
-- `source` is JSONB rather than shredded columns: LocalBagSource and
-- RemoteBagSource are heterogeneous (path/npm vs url/command/args/env/
-- session-scoped) and the union gains fields over time. Storing the discriminated
-- union whole keeps the schema stable and round-trips exactly what the YAML held.
--
-- `builtin` marks rows seeded from config/bags.builtin.yaml. It is load-bearing:
-- builtins are re-seeded from that file (it ships with the repo and changes with
-- releases), while user rows are never overwritten by a seed.

CREATE TABLE IF NOT EXISTS bags (
  name        TEXT PRIMARY KEY,
  source      JSONB NOT NULL,
  builtin     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE bags IS
  'Bag registry: which bags exist and where they resolve from. Authoritative; the on-disk snapshot is generated from this.';
COMMENT ON COLUMN bags.source IS
  'BagSource discriminated union (local: path/npm; remote: url/command/args/env), stored whole.';
COMMENT ON COLUMN bags.builtin IS
  'Seeded from config/bags.builtin.yaml. Builtins are re-seeded from that file; user rows are never overwritten.';

-- Reads filter on access level, which lives inside the JSONB blob.
CREATE INDEX IF NOT EXISTS idx_bags_builtin ON bags (builtin);
CREATE INDEX IF NOT EXISTS idx_bags_source_type ON bags ((source ->> 'type'));
