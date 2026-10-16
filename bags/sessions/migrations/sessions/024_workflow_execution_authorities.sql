-- Accepted origin/runtime/provider authority precedes destination creation.
-- Keep it in the managed Sessions migration/backup lifecycle, not startup DDL.
CREATE TABLE session_workflow_execution_authorities (
  binding_key TEXT PRIMARY KEY,
  authority_hash TEXT NOT NULL CHECK(length(authority_hash) = 64),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json))
);
CREATE TRIGGER session_workflow_execution_authority_no_update
BEFORE UPDATE ON session_workflow_execution_authorities
BEGIN SELECT RAISE(ABORT, 'workflow execution authority is immutable'); END;
CREATE TRIGGER session_workflow_execution_authority_no_delete
BEFORE DELETE ON session_workflow_execution_authorities
BEGIN SELECT RAISE(ABORT, 'workflow execution authority is immutable'); END;
