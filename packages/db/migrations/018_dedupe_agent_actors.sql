-- Deduplicate agent actors and make the seed idempotent.
--
-- BACKGROUND: seed.ts inserted agent rows with `token: token.agent()` — a
-- freshly generated random token on every run — and used
-- `onConflict(column('token')).doNothing()`. The conflict target therefore
-- never matched an existing row, so every seed run inserted a complete new set
-- of agents. Prod accumulated 98 rows for 7 distinct agents (14 each).
--
-- WHY IT MATTERED: getBarryAgentToken() selected the "Barry" agent with an
-- unordered executeTakeFirst(). With 14 candidate rows, Postgres was free to
-- return any of them, and the choice could change across plans. Session
-- attribution forked: 380 sessions carry one token, 3 carry another.
--
-- This migration collapses the duplicates to the OLDEST row per (name, type)
-- — the one existing sessions already reference — and adds the unique index
-- the seed's upsert should have been targeting all along.
--
-- sessions.agent_token is a plain TEXT column with no FK (see migration 016),
-- so deleting duplicate actor rows cannot violate referential integrity. The
-- only inbound FK is identities.actor_id, and the guard below refuses to
-- delete any row it references.

-- 1. Delete duplicate agent rows, keeping the lowest id per (name, type).
--    The NOT EXISTS guard is belt-and-braces: no identity currently points at
--    an agent actor, but a future one must never be silently orphaned.
DELETE FROM actors a
WHERE a.type = 'agent'
  AND a.id > (
    SELECT MIN(b.id) FROM actors b
    WHERE b.name = a.name AND b.type = a.type
  )
  AND NOT EXISTS (
    SELECT 1 FROM identities i WHERE i.actor_id = a.id
  );

-- 2. Prevent recurrence. Partial index: agent names are the registry keys and
--    must be unique, while user rows have no such constraint (they are
--    deduped by the existing actors_email_key).
--
--    The index is created only when step 1 fully deduplicated the table. If an
--    identity referenced a duplicate, the guard above deliberately kept that
--    row, and a bare CREATE UNIQUE INDEX would then abort the migration
--    mid-transaction. Skipping instead leaves the data correct and the
--    constraint absent, which `barry db doctor` reports rather than an
--    upgrade that dies halfway. (Verified against a fixture with an identity
--    pinned to a non-oldest duplicate.)
DO $$
DECLARE dupes INTEGER;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT name FROM actors WHERE type = 'agent' GROUP BY name HAVING count(*) > 1
  ) d;

  IF dupes = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS actors_agent_name_key
      ON actors (name) WHERE type = 'agent';
  ELSE
    RAISE WARNING
      'actors: % agent name(s) still duplicated because an identity references a non-oldest row; skipping unique index. Repoint those identities, then re-run this migration.',
      dupes;
  END IF;
END $$;
