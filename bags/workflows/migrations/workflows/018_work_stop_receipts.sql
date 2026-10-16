ALTER TABLE workflow_work_executions ADD COLUMN last_observed_at INTEGER;
CREATE INDEX workflow_work_execution_freshness ON workflow_work_executions(last_observed_at,token);
CREATE TABLE workflow_work_stop_receipts (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  request_id TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT NOT NULL,
  PRIMARY KEY(run_id,request_id)
);
CREATE TRIGGER workflow_work_stop_receipt_immutable BEFORE UPDATE ON workflow_work_stop_receipts
BEGIN SELECT RAISE(ABORT,'work stop acknowledgement is immutable'); END;
