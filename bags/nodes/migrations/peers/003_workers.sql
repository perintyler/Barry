-- Nodes are workers of a workflows owner now: no peer directory, no shared
-- identities. Credentials issued to former peers authenticated a protocol
-- that is gone, so they go too; settings (the installation id) and
-- local_identities (identity folder names) are kept.
DROP TABLE IF EXISTS identities;
DROP TABLE IF EXISTS peers;
DELETE FROM credentials;
CREATE TABLE workers(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE owners(id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, workerId TEXT NOT NULL, joinedAt TEXT NOT NULL);
