-- Physical cessation evidence is independent of retained outcome/effect metadata.
CREATE TABLE session_workflow_physical_settlements (
  segment_id TEXT PRIMARY KEY REFERENCES session_workflow_settlements(segment_id),
  proof_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  settled_at TEXT NOT NULL
);
CREATE TRIGGER session_workflow_physical_settlement_no_update
BEFORE UPDATE ON session_workflow_physical_settlements
BEGIN SELECT RAISE(ABORT, 'workflow physical settlement receipts are immutable'); END;
CREATE TRIGGER session_workflow_physical_settlement_no_delete
BEFORE DELETE ON session_workflow_physical_settlements
BEGIN SELECT RAISE(ABORT, 'workflow physical settlement receipts are immutable'); END;
