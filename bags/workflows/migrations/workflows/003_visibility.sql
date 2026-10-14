CREATE INDEX workflow_runs_page ON workflow_runs(started_at DESC,id);
CREATE INDEX workflow_runs_type_page ON workflow_runs(type,started_at DESC,id);
CREATE INDEX workflow_events_type_page ON workflow_events(run_id,type,sequence);
CREATE INDEX workflow_runs_principal_page ON workflow_runs(principal,started_at DESC,id);
CREATE INDEX workflow_runs_status_page ON workflow_runs(status,started_at DESC,id);
CREATE INDEX workflow_runs_scoped_page ON workflow_runs(principal,status,started_at DESC,id);
CREATE TABLE workflow_counts(scope TEXT NOT NULL,status TEXT NOT NULL,total INTEGER NOT NULL,PRIMARY KEY(scope,status));
INSERT INTO workflow_counts SELECT '*',status,count(*) FROM workflow_runs GROUP BY status;
INSERT INTO workflow_counts SELECT 'principal:'||principal,status,count(*) FROM workflow_runs GROUP BY principal,status;
CREATE TRIGGER workflow_counts_insert AFTER INSERT ON workflow_runs BEGIN
  INSERT INTO workflow_counts VALUES('*',new.status,1) ON CONFLICT(scope,status) DO UPDATE SET total=total+1;
  INSERT INTO workflow_counts VALUES('principal:'||new.principal,new.status,1) ON CONFLICT(scope,status) DO UPDATE SET total=total+1;
END;
CREATE TRIGGER workflow_counts_delete AFTER DELETE ON workflow_runs BEGIN
  UPDATE workflow_counts SET total=total-1 WHERE status=old.status AND scope IN ('*','principal:'||old.principal);
END;
CREATE TRIGGER workflow_counts_update AFTER UPDATE OF status,principal ON workflow_runs BEGIN
  UPDATE workflow_counts SET total=total-1 WHERE status=old.status AND scope IN ('*','principal:'||old.principal);
  INSERT INTO workflow_counts VALUES('*',new.status,1) ON CONFLICT(scope,status) DO UPDATE SET total=total+1;
  INSERT INTO workflow_counts VALUES('principal:'||new.principal,new.status,1) ON CONFLICT(scope,status) DO UPDATE SET total=total+1;
END;
CREATE TABLE workflow_dispatch_cursor(worker TEXT PRIMARY KEY,last_run TEXT NOT NULL,last_command TEXT NOT NULL);
CREATE TABLE workflow_candidate_cursor(worker TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES workflow_runs(id),position INTEGER NOT NULL,PRIMARY KEY(worker,run_id));
CREATE TABLE workflow_worker_sessions(worker TEXT NOT NULL,session TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(worker,session));
INSERT INTO workflow_worker_sessions(worker,session) SELECT substr(key,9),value FROM workflow_meta WHERE key LIKE 'session:%';
CREATE UNIQUE INDEX workflow_one_worker_session ON workflow_worker_sessions(worker) WHERE retired=0;
ALTER TABLE workflow_attempts ADD COLUMN started_at INTEGER;
ALTER TABLE workflow_attempts ADD COLUMN settled_at INTEGER;
ALTER TABLE workflow_runs ADD COLUMN retention_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_runs ADD COLUMN policy_ref TEXT;
UPDATE workflow_runs SET closed_at=coalesce((SELECT max(at) FROM workflow_events e WHERE e.run_id=workflow_runs.id),started_at) WHERE status NOT IN ('running','blocked') AND closed_at IS NULL;
CREATE TABLE workflow_policy_denials (
  key TEXT PRIMARY KEY,principal TEXT NOT NULL,operation TEXT NOT NULL,reason TEXT NOT NULL,target_hash TEXT NOT NULL,
  first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,count INTEGER NOT NULL,last_request_id TEXT NOT NULL
);
CREATE INDEX workflow_policy_denials_expiry ON workflow_policy_denials(last_at);
CREATE INDEX workflow_runs_unaccounted ON workflow_runs(id) WHERE budget_bytes=0;
CREATE TABLE workflow_byte_backfill(id INTEGER PRIMARY KEY CHECK(id=1),run_id TEXT NOT NULL,revision INTEGER NOT NULL,phase INTEGER NOT NULL,cursor INTEGER NOT NULL,bytes INTEGER NOT NULL);
INSERT INTO workflow_meta VALUES('bytes-accounted',CASE WHEN EXISTS(SELECT 1 FROM workflow_runs WHERE budget_bytes=0) THEN '0' ELSE '1' END);
