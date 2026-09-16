-- Word-indexed search vector for messages, so ranking stops being the
-- slowest and least correct part of session search.
--
-- `searchMessages` (packages/db/src/messages.ts) ranks with
-- `word_similarity(query, content_text)`. That is a per-row trigram
-- computation over text averaging 4,150 characters (largest row seen:
-- 531KB), and it dominates the query: measured alone it costs 46ms over 50
-- candidates, 239ms over 200, 292ms over 500 — linear in the candidate
-- count, which is why a cap exists at all.
--
-- The cap is also a correctness bug. It takes the 500 most RECENT ILIKE
-- matches and ranks only those, so on any common term the best match is
-- discarded before ranking ever runs: 'metrics' has 761 matches, 'postgres'
-- 748, 'barry' 9,293, 'session' 15,409. Every realistic query overflows it.
--
-- A tsvector indexes WORDS rather than every 3-character window, so the
-- index is small enough to stay resident and `ts_rank` runs against a
-- prepared vector instead of re-scanning the raw text. Benchmarked on this
-- table's real 86,600 message rows, ranking ALL matches with no cap:
--
--     term        current (capped at 200)    tsvector (uncapped)
--     metrics     309ms                      17ms
--     postgres    152ms                      10ms
--     barry       619ms                      31ms
--
-- This does NOT replace the trigram index, and `idx_messages_content_trgm`
-- must stay. A tsvector only matches whole words, so it cannot answer a
-- partial-word search that the current ILIKE path answers today — verified
-- against this data: 'postg' returns 0 tsvector hits vs 750 ILIKE, 'essio'
-- returns 0 vs 16,189. Dropping the trigram path would silently break those
-- queries. searchMessages uses this column as a fast path and falls back to
-- the existing ILIKE + word_similarity path when it returns nothing.
--
-- GENERATED ALWAYS AS ... STORED, matching migration 029: Postgres computes
-- the column for every EXISTING row during this ALTER TABLE, so there is no
-- separate backfill step to forget. (A plain column written by application
-- code would need one, and a missed backfill is exactly the gap where
-- search quietly returns fewer results for old messages than new ones while
-- fixture-based tests stay green.) `to_tsvector('english'::regconfig, ...)`
-- is immutable only with the config pinned explicitly — the one-argument
-- form depends on a session GUC and is rejected here; verified against a
-- scratch table before writing this.
--
-- `left(..., 100000)` bounds the input: building this vector over the
-- unbounded column emits `NOTICE: word is too long to be indexed` on
-- pathological rows, and a single 531KB row is not worth the index bytes.
-- 100k characters is far above any real message and keeps the cost bounded.
--
-- Plain CREATE INDEX, not CONCURRENTLY: the migration runner wraps every
-- migration in one transaction (src/migrate.ts, `sql.begin(...)`), and
-- Postgres refuses CREATE INDEX CONCURRENTLY inside a transaction block —
-- the same constraint migrations 026 and 029 document. Measured ~2.5s to
-- build this column and index over the current volume.

ALTER TABLE messages ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('english'::regconfig, left(coalesce(content_text, ''), 100000))
) STORED;

CREATE INDEX idx_messages_search_tsv ON messages USING GIN (search_tsv);
