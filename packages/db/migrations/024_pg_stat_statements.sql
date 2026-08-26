-- Per-statement timing.
--
-- The sampled barry.db.* counters say the database is working hard; they can
-- never say WHAT it is working on. This is the view that names the query.
--
-- Requires `shared_preload_libraries=pg_stat_statements`, set on the postgres
-- container in infra/compose/compose.yml. Without the preload this CREATE
-- fails outright rather than creating a view that returns nothing — which is
-- the good outcome: a silently empty stats view would read as "no slow
-- queries" on a database full of them.
--
-- Guarded so a cluster without the preload (a dev box, CI) still migrates. The
-- dashboard panel probes pg_extension and reports the extension as missing
-- rather than rendering an empty top-N.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_stat_statements unavailable (%): query timing will report as unavailable', SQLERRM;
END
$$;
