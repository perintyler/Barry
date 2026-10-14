ALTER TABLE workflow_runs ADD COLUMN grant_revision INTEGER;
ALTER TABLE workflow_attempts ADD COLUMN physical_state TEXT NOT NULL DEFAULT 'unknown' CHECK(physical_state IN ('running','settled','unknown'));
CREATE TABLE workflow_grants (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>0),
  evidence TEXT NOT NULL,
  PRIMARY KEY(run_id,revision)
);
CREATE INDEX workflow_runs_job_identity ON workflow_runs(json_extract(request,'$.job.identity'),started_at,id);
CREATE INDEX workflow_runs_job_profile ON workflow_runs(json_extract(request,'$.job.profile'),started_at,id);
CREATE TABLE workflow_session_bindings (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  state TEXT NOT NULL,
  PRIMARY KEY(run_id,step_id)
);
