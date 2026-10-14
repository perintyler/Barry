-- Repair the historical status-only closers before enforcing the lifecycle funnel.
-- Existing close triggers also queue cleanup for any process rows still attached.
UPDATE sessions
SET active = 0, state = 'closed',
    ended_at = COALESCE(ended_at, completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at = COALESCE(completed_at, ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    metadata = json_patch(COALESCE(metadata, '{}'), '{"end_reason":"terminal-status-repair"}')
WHERE status IN ('completed', 'failed', 'cancelled') AND (active = 1 OR state = 'open' OR ended_at IS NULL);

CREATE TRIGGER sessions_terminal_requires_closure
BEFORE UPDATE ON sessions
WHEN NEW.status IN ('completed', 'failed', 'cancelled')
 AND (NEW.active = 1 OR NEW.state = 'open' OR NEW.ended_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'terminal session must be closed through endSession');
END;
