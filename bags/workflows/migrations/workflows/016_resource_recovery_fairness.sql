ALTER TABLE workflow_work_resource_intents ADD COLUMN recovery_visits INTEGER NOT NULL DEFAULT 0;
CREATE INDEX workflow_work_resource_recovery_fair ON workflow_work_resource_intents(recovery_visits,token,role) WHERE settlement IS NOT NULL AND reconciled=0;
