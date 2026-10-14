-- A job's contract is pinned with its code: a run started against
-- <bag>:<job>@<version> is checked against the schemas that version declared,
-- on every owner restart, even after the bag stops registering it.
CREATE TABLE workflow_job_contracts(type TEXT PRIMARY KEY, digest TEXT NOT NULL, contract TEXT NOT NULL);
