-- Process history is node-owned; its parent may live in an identity store.
DROP TRIGGER trg_processes_close_on_session_end;
DROP INDEX idx_processes_live;
DROP INDEX idx_processes_session;
DROP INDEX idx_processes_one_live_per_session;
ALTER TABLE processes RENAME TO processes_before_node_scope;
CREATE TABLE processes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  pid             INTEGER,
  pid_started_at  INTEGER,          -- unix seconds; the anti-PID-reuse pair
  hostname        TEXT,
  process_name    TEXT,             -- ps comm, e.g. "node", "claude"
  command         TEXT,             -- full argv
  app_name        TEXT,             -- claude | codex | cursor | opencode | api | pi | antigravity
  parent_pid      INTEGER,          -- the spawner's own pid
  source          TEXT,             -- cli | api | reaper
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at        TEXT,             -- NULL = live
  last_checked_at TEXT,
  liveness        TEXT CHECK (liveness IN ('alive','dead','unknown')),
  liveness_reason TEXT              -- no-process | pid-reused | probe-failed | ...
);

CREATE INDEX idx_processes_live ON processes(ended_at) WHERE ended_at IS NULL;
CREATE INDEX idx_processes_session ON processes(session_id, started_at);
CREATE UNIQUE INDEX idx_processes_one_live_per_session
  ON processes(session_id) WHERE ended_at IS NULL;

INSERT INTO processes SELECT * FROM processes_before_node_scope;
UPDATE sqlite_sequence
   SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='processes_before_node_scope'),seq))
 WHERE name='processes';
INSERT INTO sqlite_sequence(name,seq)
SELECT 'processes',seq FROM sqlite_sequence
 WHERE name='processes_before_node_scope'
   AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='processes');
DROP TABLE processes_before_node_scope;

CREATE TRIGGER trg_processes_close_on_session_end
AFTER UPDATE OF ended_at, active ON sessions
WHEN NEW.ended_at IS NOT NULL OR NEW.active = 0
BEGIN
  UPDATE processes
     SET ended_at = COALESCE(NEW.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHERE session_id = NEW.id AND ended_at IS NULL;
END;

CREATE TRIGGER trg_processes_delete_on_session_delete
AFTER DELETE ON sessions
BEGIN
  DELETE FROM processes WHERE session_id=OLD.id;
END;
