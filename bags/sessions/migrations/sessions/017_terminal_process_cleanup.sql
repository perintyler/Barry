CREATE TRIGGER trg_processes_close_on_session_state
AFTER UPDATE OF state ON sessions
WHEN NEW.state != 'open' AND OLD.state IS NOT NEW.state
BEGIN
  UPDATE processes
     SET ended_at=COALESCE(NEW.ended_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHERE session_id=NEW.id AND ended_at IS NULL;
END;

UPDATE processes
   SET ended_at=COALESCE(
     (SELECT ended_at FROM sessions WHERE sessions.id=processes.session_id),
     strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 WHERE ended_at IS NULL
   AND EXISTS(SELECT 1 FROM sessions
               WHERE sessions.id=processes.session_id
                 AND (sessions.state != 'open' OR sessions.ended_at IS NOT NULL));
