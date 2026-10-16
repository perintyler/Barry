ALTER TABLE sessions ADD COLUMN bags TEXT NOT NULL DEFAULT '[]';
UPDATE sessions SET bags = traits WHERE bags = '[]' AND traits != '[]';

DROP TRIGGER IF EXISTS sessions_revoke_workflow_credential;

CREATE TRIGGER sessions_revoke_workflow_credential
AFTER UPDATE OF state, ended_at, user_id, identity_id, bags, bounds, bound, metadata ON sessions
WHEN NEW.workflow_credential_id IS NOT NULL AND (
  NEW.state <> 'open' OR NEW.ended_at IS NOT NULL
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.identity_id IS NOT OLD.identity_id
  OR NEW.bags IS NOT OLD.bags
  OR NEW.bounds IS NOT OLD.bounds
  OR NEW.bound IS NOT OLD.bound
  OR json_extract(NEW.metadata, '$.workflow_bound') IS NOT json_extract(OLD.metadata, '$.workflow_bound')
  OR json_extract(NEW.metadata, '$.workflow_identity_id') IS NOT json_extract(OLD.metadata, '$.workflow_identity_id')
)
BEGIN
  UPDATE sessions SET workflow_credential_id = NULL WHERE id = NEW.id;
END;
