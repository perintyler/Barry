-- Actual worker identity is retained with the physical claim; legacy NULL stays unknown.
ALTER TABLE session_workflow_settlements ADD COLUMN owner_process_json TEXT;
-- One metadata-only repair receipt per actual run segment. It never admits a new turn.
CREATE TABLE session_workflow_outcome_recoveries (
  segment_id TEXT PRIMARY KEY REFERENCES session_workflow_settlements(segment_id),
  outcome_hash TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  physicalproof_json TEXT NOT NULL,
  prior_revision INTEGER NOT NULL,
  repaired_revision INTEGER NOT NULL,
  repaired_at TEXT NOT NULL
);
-- Repairs are append-only evidence; a conflicting import never rewrites history.
CREATE TRIGGER session_workflow_outcome_recovery_no_update
BEFORE UPDATE ON session_workflow_outcome_recoveries
BEGIN SELECT RAISE(ABORT, 'workflow outcome recovery receipts are immutable'); END;
CREATE TRIGGER session_workflow_outcome_recovery_no_delete
BEFORE DELETE ON session_workflow_outcome_recoveries
BEGIN SELECT RAISE(ABORT, 'workflow outcome recovery receipts are immutable'); END;
