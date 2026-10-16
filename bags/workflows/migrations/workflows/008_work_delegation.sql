-- Verified issuer nonces are consumed in the same acceptance transaction.
-- Retain bindings for exact-key redelivery; never persist bearer assertions.
CREATE TABLE workflow_work_nonces (
  issuer TEXT NOT NULL,
  nonce TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  binding TEXT NOT NULL,
  assertion_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(issuer,nonce)
);
CREATE TRIGGER workflow_work_nonces_immutable BEFORE UPDATE ON workflow_work_nonces
BEGIN SELECT RAISE(ABORT,'delegation nonce binding is immutable'); END;

CREATE TABLE workflow_work_delegations (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  record_digest TEXT NOT NULL,
  evidence TEXT NOT NULL,
  PRIMARY KEY(run_id,record_digest)
);
CREATE TRIGGER workflow_work_delegations_immutable BEFORE UPDATE ON workflow_work_delegations
BEGIN SELECT RAISE(ABORT,'transferred delegation evidence is immutable'); END;
