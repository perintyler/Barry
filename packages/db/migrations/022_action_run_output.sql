-- Action run outputs (typed I/O).
--
-- `output` is the deliverable the agent handed to `complete_action`, stored
-- verbatim (JSON-serialized text when the action declares a schema-typed
-- output). It is distinct from `summary`, the one-line status every run has:
-- a summary says the work happened, the output IS the work product.
--
-- `output_type` ('json' | 'text') is snapshotted per row so the row stays
-- self-describing after the action definition is edited or deleted — reading
-- back a run must not require the action that produced it to still exist.
--
-- NULL semantics: both NULL = the action declared no output (or the run
-- predates this column). A CLOSED run of an output-declaring action is never
-- NULL, because `complete_action` rejects the call rather than closing without
-- one — "declared but missing" is not a representable closed state. Empty
-- string is not legal either: an empty output is a missing output. The CHECK
-- makes the pairing objective rather than a comment a future writer can drift
-- from.

ALTER TABLE action_runs
  ADD COLUMN output TEXT,
  ADD COLUMN output_type TEXT,
  ADD CONSTRAINT action_runs_output_paired CHECK ((output IS NULL) = (output_type IS NULL));

COMMENT ON COLUMN action_runs.output IS
  'Deliverable handed to complete_action, verbatim (JSON text for schema-typed outputs). NULL = the action declared no output.';
COMMENT ON COLUMN action_runs.output_type IS
  'How to read output: ''json'' or ''text''. Snapshotted so the row outlives edits to the action. NULL iff output is NULL.';
