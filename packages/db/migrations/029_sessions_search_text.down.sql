DROP INDEX IF EXISTS idx_sessions_search_text_trgm;
ALTER TABLE sessions DROP COLUMN IF EXISTS search_text;
