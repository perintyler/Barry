CREATE TABLE workflow_recovery_activations (
  epoch TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request TEXT NOT NULL,
  response TEXT NOT NULL
);
CREATE TRIGGER workflow_recovery_activation_immutable BEFORE UPDATE ON workflow_recovery_activations
BEGIN SELECT RAISE(ABORT,'recovery activation audit is immutable'); END;
