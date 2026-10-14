ALTER TABLE workflow_runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_runs ADD COLUMN artifact TEXT;
ALTER TABLE workflow_runs ADD COLUMN principal TEXT NOT NULL DEFAULT 'local-operator';
ALTER TABLE workflow_runs ADD COLUMN closed_at INTEGER;
ALTER TABLE workflow_runs ADD COLUMN budget_bytes INTEGER NOT NULL DEFAULT 0;
INSERT INTO workflow_meta VALUES('reserved-bytes','0');
CREATE TABLE workflow_due (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id), due_at INTEGER NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 1, token TEXT, reserved_until INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX workflow_due_ready ON workflow_due(due_at, reserved_until);
INSERT INTO workflow_due(run_id,due_at) SELECT id,0 FROM workflow_runs WHERE status IN ('running','blocked');
CREATE TABLE workflow_receipts (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id), id TEXT NOT NULL, request TEXT NOT NULL,
  response TEXT NOT NULL, PRIMARY KEY(run_id,id)
);
CREATE TABLE workflow_claims (
  worker TEXT NOT NULL, request_id TEXT NOT NULL, task TEXT, expires_at INTEGER NOT NULL,
  PRIMARY KEY(worker,request_id)
);
CREATE INDEX workflow_claims_expiry ON workflow_claims(expires_at);
CREATE TABLE workflow_artifacts (type TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(type,version));
CREATE TABLE workflow_payloads (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id), id TEXT NOT NULL, value TEXT NOT NULL,
  bytes INTEGER NOT NULL, PRIMARY KEY(run_id,id)
);
CREATE TABLE workflow_tombstones (
  id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, principal TEXT NOT NULL,
  summary TEXT NOT NULL, closed_at INTEGER NOT NULL
);
CREATE INDEX workflow_runs_closed ON workflow_runs(closed_at,id);
CREATE INDEX workflow_commands_expiry ON workflow_commands(state,deadline,run_id);
CREATE INDEX workflow_commands_lease ON workflow_commands(state,lease_until,run_id);
UPDATE workflow_meta SET value='2' WHERE key='format';
INSERT INTO workflow_meta VALUES('epoch',lower(hex(randomblob(16))));
