ALTER TABLE workers ADD COLUMN jobs TEXT;
ALTER TABLE workers ADD COLUMN inviteExpiresAt INTEGER;
ALTER TABLE workers ADD COLUMN joinedAt INTEGER;
ALTER TABLE owners ADD COLUMN jobs TEXT;
CREATE TABLE worker_audit(id INTEGER PRIMARY KEY, workerId TEXT NOT NULL, time INTEGER NOT NULL, caller TEXT NOT NULL, event TEXT NOT NULL);
CREATE INDEX worker_audit_worker ON worker_audit(workerId,time);
