ALTER TABLE action_work_projection_owner ADD COLUMN generation TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE action_work_projections ADD COLUMN generation TEXT NOT NULL DEFAULT 'initial';
CREATE TABLE action_work_projection_generations (
  generation TEXT PRIMARY KEY,
  previous_generation TEXT,
  prepared_at TEXT NOT NULL
);
-- Newer pre-restore observations remain evidence after canonical rebuilding.
CREATE TABLE action_work_projection_history (
  action_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  record TEXT NOT NULL,
  result TEXT,
  PRIMARY KEY(action_id, generation, revision)
);
