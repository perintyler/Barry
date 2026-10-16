CREATE TABLE workflow_work_index (
  work_id TEXT PRIMARY KEY REFERENCES workflow_work_admissions(work_id),
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),
  installation TEXT NOT NULL,
  namespace_hash TEXT NOT NULL,
  identity_id TEXT,
  state TEXT NOT NULL,
  definition_kind TEXT NOT NULL,
  definition_ref TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL UNIQUE
);
CREATE INDEX workflow_work_index_namespace ON workflow_work_index(namespace_hash,accepted_at DESC,work_id DESC);
CREATE INDEX workflow_work_index_identity ON workflow_work_index(installation,identity_id,accepted_at DESC,work_id DESC);
CREATE INDEX workflow_work_index_installation ON workflow_work_index(installation,accepted_at DESC,work_id DESC);
CREATE INDEX workflow_work_index_state ON workflow_work_index(installation,identity_id,state,accepted_at DESC,work_id DESC);
CREATE INDEX workflow_work_index_filters ON workflow_work_index(namespace_hash,state,definition_kind,trigger_kind,accepted_at DESC,work_id DESC);
CREATE INDEX workflow_work_operation_keys ON workflow_work_admissions(idempotency_key);
CREATE TRIGGER workflow_work_index_binding_immutable BEFORE UPDATE OF work_id,run_id,installation,namespace_hash,identity_id,definition_kind,definition_ref,trigger_kind,accepted_at,sequence ON workflow_work_index
BEGIN SELECT RAISE(ABORT,'canonical work index binding is immutable'); END;
INSERT INTO workflow_meta VALUES('work-index-ready',CASE WHEN EXISTS(SELECT 1 FROM workflow_work_admissions) THEN '0' ELSE '1' END);
INSERT INTO workflow_meta VALUES('work-index-sequence','0');
INSERT INTO workflow_meta VALUES('work-cursor-key',lower(hex(randomblob(32))));
