-- Canonical work admission is in the owner's transaction, never a second queue.
CREATE TABLE workflow_work_admissions (
  work_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),
  namespace_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  record TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  UNIQUE(namespace_hash,idempotency_key)
);
CREATE INDEX workflow_work_admissions_page ON workflow_work_admissions(accepted_at,work_id);
CREATE TABLE workflow_work_grants (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  grant_ref TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  digest TEXT NOT NULL,
  evidence TEXT NOT NULL,
  PRIMARY KEY(run_id,revision)
);
CREATE TABLE workflow_work_sources (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  namespace_hash TEXT NOT NULL,
  digest TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes>=0),
  purpose TEXT NOT NULL,
  PRIMARY KEY(run_id,namespace_hash,digest,purpose)
);
CREATE TABLE workflow_work_reservations (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
  reservation_id TEXT NOT NULL UNIQUE,
  executor TEXT NOT NULL,
  lane TEXT NOT NULL,
  caller TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','released'))
);
CREATE INDEX workflow_work_reservations_capacity ON workflow_work_reservations(executor,lane,state,caller);
CREATE TABLE workflow_work_outbox (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  kind TEXT NOT NULL CHECK(kind IN ('projection','notification')),
  desired_revision INTEGER NOT NULL CHECK(desired_revision>0),
  applied_revision INTEGER NOT NULL DEFAULT 0 CHECK(applied_revision>=0),
  body TEXT NOT NULL,
  PRIMARY KEY(run_id,kind)
);
-- Until work retention creates permanent admission tombstones, these foreign
-- keys deliberately pin canonical work, grants, sources and pending outboxes.

CREATE TABLE workflow_work_artifact_gc (
  namespace_hash TEXT NOT NULL,
  file TEXT NOT NULL,
  file_identity TEXT NOT NULL,
  marked_at INTEGER NOT NULL,
  PRIMARY KEY(namespace_hash,file)
);

CREATE TRIGGER workflow_work_grants_immutable BEFORE UPDATE ON workflow_work_grants
BEGIN SELECT RAISE(ABORT,'work grant evidence is immutable'); END;
CREATE TRIGGER workflow_work_admission_binding_immutable BEFORE UPDATE ON workflow_work_admissions
WHEN NEW.work_id!=OLD.work_id OR NEW.run_id!=OLD.run_id OR NEW.namespace_hash!=OLD.namespace_hash
  OR NEW.idempotency_key!=OLD.idempotency_key OR NEW.request_hash!=OLD.request_hash
  OR NEW.accepted_at!=OLD.accepted_at OR json_extract(NEW.record,'$.plan_digest')!=json_extract(OLD.record,'$.plan_digest')
BEGIN SELECT RAISE(ABORT,'work admission binding is immutable'); END;
