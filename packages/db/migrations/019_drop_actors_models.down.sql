-- Restore the column. Data is NOT restored: it was a derived snapshot of the
-- model catalog with no readers, so an empty default loses nothing.
ALTER TABLE actors ADD COLUMN IF NOT EXISTS models JSONB NOT NULL DEFAULT '[]';
