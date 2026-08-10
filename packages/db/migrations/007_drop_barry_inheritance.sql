-- Barrys no longer inherit from a parent.
--
-- Config used to be resolved at read time by walking parent_id and merging
-- root-first (resolveBarryConfig). With the link gone, each Barry must already
-- carry its full effective config, so flatten every child before dropping the
-- column. The merge below reproduces the old resolver exactly:
--
--   env      shallow merge, child wins
--   traits   union
--   blocks   union
--   scalars  nearest-to-self value wins
--
-- Inline `scope` accumulated in the resolver rather than overriding, so a child
-- could not shed a restricted parent's denials. No child inherits a scope, so
-- nearest-wins is equivalent here; the enforcement layer still unions scopes
-- from every other source.
--
-- IRREVERSIBLE — there is deliberately no .down.sql. Restoring parent_id would
-- re-establish inheritance while the flattened copy stayed in place, applying
-- every inherited key twice. Roll back by restoring from backup.

-- Guarded so the file is safe to re-run: after the column is gone there is
-- nothing left to flatten, and the recursive CTE would not parse.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'barrys' AND column_name = 'parent_id'
  ) THEN

    WITH RECURSIVE chain AS (
      -- Seed with every barry that has a parent. depth 0 is the barry itself.
      SELECT b.id AS leaf_id, b.id AS node_id, b.parent_id, 0 AS depth
      FROM barrys b
      WHERE b.parent_id IS NOT NULL

      UNION ALL

      -- Walk upward. The depth cap mirrors the old MAX_INHERITANCE_DEPTH and
      -- guarantees termination even if a cycle somehow exists.
      SELECT c.leaf_id, p.id, p.parent_id, c.depth + 1
      FROM chain c
      JOIN barrys p ON p.id = c.parent_id
      WHERE c.depth < 10
    ),
    ordered AS (
      SELECT c.leaf_id, c.depth, b.metadata
      FROM chain c
      JOIN barrys b ON b.id = c.node_id
    ),
    merged AS (
      SELECT
        m.leaf_id,
        -- Lowest depth wins, i.e. the barry's own value beats an ancestor's.
        COALESCE(
          (SELECT jsonb_object_agg(picked.key, picked.value)
           FROM (
             SELECT DISTINCT ON (e.key) e.key, e.value
             FROM ordered o
             CROSS JOIN LATERAL jsonb_each(COALESCE(o.metadata->'env', '{}'::jsonb)) e
             WHERE o.leaf_id = m.leaf_id
             ORDER BY e.key, o.depth ASC
           ) picked),
          '{}'::jsonb
        ) AS env,
        COALESCE(
          (SELECT jsonb_agg(DISTINCT t.value)
           FROM ordered o
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(o.metadata->'traits') = 'array'
                  THEN o.metadata->'traits' ELSE '[]'::jsonb END) t
           WHERE o.leaf_id = m.leaf_id),
          '[]'::jsonb
        ) AS traits,
        COALESCE(
          (SELECT jsonb_agg(DISTINCT bl.value)
           FROM ordered o
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(o.metadata->'blocks') = 'array'
                  THEN o.metadata->'blocks' ELSE '[]'::jsonb END) bl
           WHERE o.leaf_id = m.leaf_id),
          '[]'::jsonb
        ) AS blocks,
        (SELECT o.metadata->'vault' FROM ordered o
          WHERE o.leaf_id = m.leaf_id AND o.metadata ? 'vault'
          ORDER BY o.depth ASC LIMIT 1) AS vault,
        (SELECT o.metadata->'scope_id' FROM ordered o
          WHERE o.leaf_id = m.leaf_id AND o.metadata ? 'scope_id'
          ORDER BY o.depth ASC LIMIT 1) AS scope_id,
        (SELECT o.metadata->'scope' FROM ordered o
          WHERE o.leaf_id = m.leaf_id
            AND o.metadata ? 'scope'
            AND o.metadata->'scope' <> '{}'::jsonb
          ORDER BY o.depth ASC LIMIT 1) AS scope,
        (SELECT o.metadata->'default_coding_agent' FROM ordered o
          WHERE o.leaf_id = m.leaf_id AND o.metadata ? 'default_coding_agent'
          ORDER BY o.depth ASC LIMIT 1) AS default_coding_agent,
        (SELECT o.metadata->'default_model' FROM ordered o
          WHERE o.leaf_id = m.leaf_id AND o.metadata ? 'default_model'
          ORDER BY o.depth ASC LIMIT 1) AS default_model,
        -- Matches the resolver's `status_notify?.tool` gate: a notifier with no
        -- tool never took effect, so it must not win here either.
        (SELECT o.metadata->'status_notify' FROM ordered o
          WHERE o.leaf_id = m.leaf_id AND o.metadata->'status_notify' ? 'tool'
          ORDER BY o.depth ASC LIMIT 1) AS status_notify,
        (SELECT o.metadata->'allow_native_tools' FROM ordered o
          WHERE o.leaf_id = m.leaf_id
            AND jsonb_typeof(o.metadata->'allow_native_tools') = 'boolean'
          ORDER BY o.depth ASC LIMIT 1) AS allow_native_tools
      FROM (SELECT DISTINCT leaf_id FROM ordered) m
    )
    UPDATE barrys b
    SET metadata = b.metadata
      || CASE WHEN mg.env    <> '{}'::jsonb THEN jsonb_build_object('env', mg.env)       ELSE '{}'::jsonb END
      || CASE WHEN mg.traits <> '[]'::jsonb THEN jsonb_build_object('traits', mg.traits) ELSE '{}'::jsonb END
      || CASE WHEN mg.blocks <> '[]'::jsonb THEN jsonb_build_object('blocks', mg.blocks) ELSE '{}'::jsonb END
      || CASE WHEN mg.vault                IS NOT NULL THEN jsonb_build_object('vault', mg.vault)                               ELSE '{}'::jsonb END
      || CASE WHEN mg.scope_id             IS NOT NULL THEN jsonb_build_object('scope_id', mg.scope_id)                         ELSE '{}'::jsonb END
      || CASE WHEN mg.scope                IS NOT NULL THEN jsonb_build_object('scope', mg.scope)                               ELSE '{}'::jsonb END
      || CASE WHEN mg.default_coding_agent IS NOT NULL THEN jsonb_build_object('default_coding_agent', mg.default_coding_agent) ELSE '{}'::jsonb END
      || CASE WHEN mg.default_model        IS NOT NULL THEN jsonb_build_object('default_model', mg.default_model)               ELSE '{}'::jsonb END
      || CASE WHEN mg.status_notify        IS NOT NULL THEN jsonb_build_object('status_notify', mg.status_notify)               ELSE '{}'::jsonb END
      || CASE WHEN mg.allow_native_tools   IS NOT NULL THEN jsonb_build_object('allow_native_tools', mg.allow_native_tools)     ELSE '{}'::jsonb END
    FROM merged mg
    WHERE b.id = mg.leaf_id;

  END IF;
END $$;

-- `parent_name` mirrored the yaml `parent:` key for display only. Nothing
-- resolves config through it now, and at least one row points at a Barry that
-- has never existed.
UPDATE barrys
SET metadata = metadata - 'parent_name'
WHERE metadata ? 'parent_name';

-- Dropping the column takes barrys_parent_id_fkey with it; naming the
-- constraint and index keeps the intent legible and makes the file safe to
-- re-run against a database where the column was already removed by hand.
DROP INDEX IF EXISTS idx_barrys_parent_id;
ALTER TABLE barrys DROP CONSTRAINT IF EXISTS barrys_parent_id_fkey;
ALTER TABLE barrys DROP COLUMN IF EXISTS parent_id;
