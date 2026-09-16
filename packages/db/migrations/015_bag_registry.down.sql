-- Drop the Postgres bag registry. Only safe alongside a code rollback to a
-- build that still reads the YAML registry; the YAML files are left untouched
-- by the up migration precisely so this is recoverable.
DROP INDEX IF EXISTS idx_bags_source_type;
DROP INDEX IF EXISTS idx_bags_builtin;
DROP TABLE IF EXISTS bags;
