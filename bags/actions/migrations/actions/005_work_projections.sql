-- This store is a compatibility projection. Workflow ownership never migrates
-- to the Actions runner or session orphan sweeper.
CREATE TABLE action_work_projection_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  namespace TEXT NOT NULL
);
CREATE TABLE action_work_projections (
  action_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL UNIQUE,
  workflow_id TEXT NOT NULL UNIQUE,
  binding TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  record TEXT NOT NULL,
  result TEXT
);
