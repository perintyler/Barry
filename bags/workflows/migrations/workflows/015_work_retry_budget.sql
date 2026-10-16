ALTER TABLE workflow_commands ADD COLUMN work_retry_deadline INTEGER;
CREATE TRIGGER workflow_work_retry_deadline_immutable BEFORE UPDATE OF work_retry_deadline ON workflow_commands WHEN OLD.work_retry_deadline IS NOT NULL AND OLD.work_retry_deadline IS NOT NEW.work_retry_deadline BEGIN SELECT RAISE(ABORT,'retry deadline is immutable'); END;
DROP TRIGGER workflow_work_execution_request_immutable;
CREATE TRIGGER workflow_work_execution_request_immutable BEFORE UPDATE OF request ON workflow_work_executions
WHEN coalesce((
  json_extract(OLD.request,'$.launch_authorized')=0 AND json_extract(NEW.request,'$.launch_authorized')=1
  AND OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL
  AND OLD.observation_revision=0 AND OLD.receipt IS NULL
  AND json_remove(OLD.request,'$.deadline','$.launch_authorized','$.resources.host_reservation','$.resources.endpoint.reservation','$.budget_deadline')
    =json_remove(NEW.request,'$.deadline','$.launch_authorized','$.resources.host_reservation','$.resources.endpoint.reservation','$.budget_deadline')
  AND json_extract(NEW.request,'$.resources.host_reservation')=(SELECT reservation FROM workflow_work_resource_intents WHERE token=OLD.token AND role='host')
  AND (json_extract(NEW.request,'$.resources.endpoint') IS NULL OR
    json_extract(NEW.request,'$.resources.endpoint.reservation')=(SELECT reservation FROM workflow_work_resource_intents WHERE token=OLD.token AND role='endpoint'))
),0)=0
BEGIN SELECT RAISE(ABORT,'start permit requires immutable resource acknowledgements'); END;
