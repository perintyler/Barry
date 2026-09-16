ALTER TABLE action_runs
  DROP COLUMN IF EXISTS validated_at,
  DROP COLUMN IF EXISTS validation_failures;
