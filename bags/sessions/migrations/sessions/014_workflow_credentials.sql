-- A resumed session must never revive the credential from its previous run.
ALTER TABLE sessions ADD COLUMN workflow_credential_id TEXT;

CREATE TRIGGER sessions_revoke_workflow_credential
AFTER UPDATE OF state, ended_at, user_id, identity_id, metadata ON sessions
WHEN NEW.workflow_credential_id IS NOT NULL AND (
  NEW.state <> 'open' OR NEW.ended_at IS NOT NULL
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.identity_id IS NOT OLD.identity_id
  OR json_extract(NEW.metadata, '$.workflow_scope') IS NOT json_extract(OLD.metadata, '$.workflow_scope')
  OR json_extract(NEW.metadata, '$.workflow_identity_id') IS NOT json_extract(OLD.metadata, '$.workflow_identity_id')
)
BEGIN
  UPDATE sessions SET workflow_credential_id = NULL WHERE id = NEW.id;
END;
