-- Drop provenance. messages.model_id data is lost: it is only reconstructible
-- from the providers/models rows this also removes.
DROP INDEX IF EXISTS idx_messages_model_id;
ALTER TABLE messages DROP COLUMN IF EXISTS model_id;
DROP TABLE IF EXISTS models;
DROP TABLE IF EXISTS providers;
