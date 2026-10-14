// Generated from SQL migrations. Run pnpm stores:generate; do not edit.
export default [
  {
    "name": "001_baseline.sql",
    "sql": "\n      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);\n      CREATE TABLE IF NOT EXISTS peers(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, address TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'unknown', lastContact TEXT, failures INTEGER NOT NULL DEFAULT 0, failedSince INTEGER, directoryRevision TEXT, lastError TEXT);\n      CREATE TABLE IF NOT EXISTS local_identities(legacyId INTEGER PRIMARY KEY, uuid TEXT UNIQUE NOT NULL);\n      CREATE TABLE IF NOT EXISTS credentials(id TEXT PRIMARY KEY, peerId TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);\n      CREATE TABLE IF NOT EXISTS identities(peerId TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(peerId,id));"
  },
  {
    "name": "002_credential_expiry.sql",
    "sql": "ALTER TABLE credentials ADD COLUMN expiresAt INTEGER;\nALTER TABLE credentials ADD COLUMN revokedAt INTEGER;\n"
  },
  {
    "name": "003_workers.sql",
    "sql": "-- Nodes are workers of a workflows owner now: no peer directory, no shared\n-- identities. Credentials issued to former peers authenticated a protocol\n-- that is gone, so they go too; settings (the installation id) and\n-- local_identities (identity folder names) are kept.\nDROP TABLE IF EXISTS identities;\nDROP TABLE IF EXISTS peers;\nDELETE FROM credentials;\nCREATE TABLE workers(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, createdAt TEXT NOT NULL);\nCREATE TABLE owners(id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, workerId TEXT NOT NULL, joinedAt TEXT NOT NULL);\n"
  },
  {
    "name": "004_worker_trust.sql",
    "sql": "ALTER TABLE workers ADD COLUMN jobs TEXT;\nALTER TABLE workers ADD COLUMN inviteExpiresAt INTEGER;\nALTER TABLE workers ADD COLUMN joinedAt INTEGER;\nALTER TABLE owners ADD COLUMN jobs TEXT;\nCREATE TABLE worker_audit(id INTEGER PRIMARY KEY, workerId TEXT NOT NULL, time INTEGER NOT NULL, caller TEXT NOT NULL, event TEXT NOT NULL);\nCREATE INDEX worker_audit_worker ON worker_audit(workerId,time);\n"
  }
];
