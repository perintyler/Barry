ALTER TABLE workflow_work_executions ADD COLUMN activated_at INTEGER;
-- Preserve the original rules of retained, already-authorized generations.
UPDATE workflow_work_executions SET activated_at=(SELECT started_at FROM workflow_attempts a WHERE a.token=workflow_work_executions.token)
WHERE json_extract(request,'$.launch_authorized') IS NULL;
DROP TRIGGER workflow_work_execution_binding_immutable;
CREATE TRIGGER workflow_work_execution_binding_immutable BEFORE UPDATE OF token,run_id,worker,owner_epoch ON workflow_work_executions
BEGIN SELECT RAISE(ABORT,'work execution binding is immutable'); END;
CREATE TRIGGER workflow_work_execution_request_immutable BEFORE UPDATE OF request ON workflow_work_executions
WHEN coalesce((
  json_extract(OLD.request,'$.launch_authorized')=0 AND json_extract(NEW.request,'$.launch_authorized')=1
  AND OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL
  AND OLD.observation_revision=0 AND OLD.receipt IS NULL
  AND json_remove(OLD.request,'$.deadline','$.launch_authorized')=json_remove(NEW.request,'$.deadline','$.launch_authorized')
),0)=0
BEGIN SELECT RAISE(ABORT,'only unlaunched reservation may become an immutable start permit'); END;
