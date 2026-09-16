DROP INDEX IF EXISTS idx_messages_search_tsv;
ALTER TABLE messages DROP COLUMN IF EXISTS search_tsv;
