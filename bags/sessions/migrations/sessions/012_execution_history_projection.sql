ALTER TABLE session_execution_events ADD COLUMN history_projected_at TEXT;
CREATE INDEX session_execution_events_unprojected ON session_execution_events(sequence)
  WHERE history_projected_at IS NULL;
