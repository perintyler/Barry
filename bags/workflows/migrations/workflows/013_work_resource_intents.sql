CREATE TABLE workflow_work_resource_intents(
  token TEXT NOT NULL REFERENCES workflow_work_executions(token),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  role TEXT NOT NULL CHECK(role IN ('host','endpoint')),
  broker TEXT NOT NULL,
  request TEXT NOT NULL,
  reservation TEXT,
  settlement TEXT,
  reconciled INTEGER NOT NULL DEFAULT 0 CHECK(reconciled IN (0,1)),
  PRIMARY KEY(token,role)
);
CREATE INDEX workflow_work_resource_recovery ON workflow_work_resource_intents(token,role) WHERE settlement IS NOT NULL AND reconciled=0;
CREATE TRIGGER workflow_work_resource_intent_immutable BEFORE UPDATE OF token,run_id,role,broker,request ON workflow_work_resource_intents
BEGIN SELECT RAISE(ABORT,'resource acquisition intent is immutable'); END;
CREATE TRIGGER workflow_work_resource_ack_immutable BEFORE UPDATE OF reservation ON workflow_work_resource_intents
WHEN OLD.reservation IS NOT NULL AND OLD.reservation IS NOT NEW.reservation
BEGIN SELECT RAISE(ABORT,'resource acknowledgement is immutable'); END;
CREATE TRIGGER workflow_work_resource_settlement_immutable BEFORE UPDATE OF settlement ON workflow_work_resource_intents
WHEN OLD.settlement IS NOT NULL AND OLD.settlement IS NOT NEW.settlement
BEGIN SELECT RAISE(ABORT,'resource settlement proof is immutable'); END;
DROP TRIGGER workflow_work_execution_request_immutable;
CREATE TRIGGER workflow_work_execution_request_immutable BEFORE UPDATE OF request ON workflow_work_executions
WHEN coalesce((
  json_extract(OLD.request,'$.launch_authorized')=0 AND json_extract(NEW.request,'$.launch_authorized')=1
  AND OLD.activated_at IS NULL AND NEW.activated_at IS NOT NULL
  AND OLD.observation_revision=0 AND OLD.receipt IS NULL
  AND json_remove(OLD.request,'$.deadline','$.launch_authorized','$.resources.host_reservation','$.resources.endpoint.reservation')
    =json_remove(NEW.request,'$.deadline','$.launch_authorized','$.resources.host_reservation','$.resources.endpoint.reservation')
  AND json_extract(NEW.request,'$.resources.host_reservation')=(SELECT reservation FROM workflow_work_resource_intents WHERE token=OLD.token AND role='host')
  AND (json_extract(NEW.request,'$.resources.endpoint') IS NULL OR
    json_extract(NEW.request,'$.resources.endpoint.reservation')=(SELECT reservation FROM workflow_work_resource_intents WHERE token=OLD.token AND role='endpoint'))
),0)=0
BEGIN SELECT RAISE(ABORT,'start permit requires immutable resource acknowledgements'); END;
