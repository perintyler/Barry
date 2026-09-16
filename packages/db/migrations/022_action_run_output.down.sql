ALTER TABLE action_runs
  DROP CONSTRAINT IF EXISTS action_runs_output_paired,
  DROP COLUMN IF EXISTS output,
  DROP COLUMN IF EXISTS output_type;
