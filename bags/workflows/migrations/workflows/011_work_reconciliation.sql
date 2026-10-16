CREATE TABLE workflow_work_reconciliations (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  request_id TEXT NOT NULL,
  request TEXT NOT NULL,
  audit TEXT NOT NULL,
  response TEXT NOT NULL,
  PRIMARY KEY(run_id,request_id)
);
CREATE TRIGGER workflow_work_reconciliation_immutable BEFORE UPDATE ON workflow_work_reconciliations
BEGIN SELECT RAISE(ABORT,'work reconciliation audit is immutable'); END;
