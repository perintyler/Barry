CREATE TABLE workflow_work_executions (
  token TEXT PRIMARY KEY REFERENCES workflow_attempts(token),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  worker TEXT NOT NULL,
  owner_epoch TEXT NOT NULL,
  request TEXT NOT NULL,
  observation TEXT NOT NULL,
  receipt TEXT,
  receipt_digest TEXT,
  observation_revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX workflow_work_executions_run ON workflow_work_executions(run_id,token);
CREATE TRIGGER workflow_work_execution_binding_immutable BEFORE UPDATE OF token,run_id,worker,owner_epoch,request ON workflow_work_executions
BEGIN SELECT RAISE(ABORT,'work execution binding is immutable'); END;
CREATE TRIGGER workflow_work_execution_receipt_immutable BEFORE UPDATE OF receipt,receipt_digest ON workflow_work_executions
WHEN OLD.receipt IS NOT NULL
BEGIN SELECT RAISE(ABORT,'work execution receipt is immutable'); END;
