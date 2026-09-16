-- Precomputed, indexed search text for sessions (astra review SR3).
--
-- `searchSessions` (packages/db/src/sessions.ts) matches a query against
-- seven separate fields — id, four metadata->> keys, a jsonb_array_elements_text
-- scan over metadata->'tags', and summary — via unindexed LIKE/EXISTS on
-- every one, on every call. None of those individually has an index that
-- helps a substring search, and running seven scans per query does not get
-- cheaper as the sessions table grows.
--
-- `search_text` folds all of that into one lowercased column, computed by
-- Postgres itself (GENERATED ALWAYS AS ... STORED), then indexed with a
-- trigram GIN index so a substring LIKE against it can actually use an
-- index instead of a sequential scan.
--
-- Backfill is not a separate step and cannot be forgotten: a STORED
-- generated column is computed for every EXISTING row at the moment this
-- ALTER TABLE runs, not only for rows inserted afterward — verified against
-- a scratch database with a pre-existing row before writing this migration.
-- (The alternative shape — a plain column populated by application code on
-- write — would need an explicit backfill for old rows, and a missed
-- backfill is exactly the kind of gap where search silently returns fewer
-- results for old sessions than new ones while every test built on fresh
-- fixtures stays green.)
--
-- `tags` folds in via a plain `::text` cast of the whole jsonb array, not
-- `jsonb_array_elements_text` per element: a STORED generated column's
-- expression must be immutable and cannot contain a subquery or a
-- set-returning function, so the element-wise expansion `searchSessions`
-- currently uses in application code is not legal here. The cast form
-- (`tags::text` = '["litellm", "eng-2925"]') still supports
-- substring matching against individual tag values — tested directly
-- against a scratch database before writing this migration — because each
-- tag's text still appears verbatim inside the array's JSON text
-- representation.
--
-- Plain CREATE INDEX, not CONCURRENTLY: this repo's migration runner wraps
-- every migration in one transaction (src/migrate.ts), and Postgres refuses
-- CREATE INDEX CONCURRENTLY inside a transaction block — same constraint
-- migration 026 documents for its own index.

ALTER TABLE sessions ADD COLUMN search_text TEXT GENERATED ALWAYS AS (
  lower(
    coalesce(id, '') || ' ' ||
    coalesce(metadata->>'working_directory', '') || ' ' ||
    coalesce(metadata->>'git_branch', '') || ' ' ||
    coalesce(metadata->>'git_remote', '') || ' ' ||
    coalesce(metadata->>'directive', '') || ' ' ||
    coalesce(metadata->>'name', '') || ' ' ||
    coalesce((metadata->'tags')::text, '') || ' ' ||
    coalesce(summary, '')
  )
) STORED;

CREATE INDEX idx_sessions_search_text_trgm ON sessions USING GIN (search_text gin_trgm_ops);
