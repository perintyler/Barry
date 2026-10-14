CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64),
  token_prefix TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL CHECK(json_valid(scopes) AND json_type(scopes) = 'array'),
  identity_ids TEXT NOT NULL CHECK(json_valid(identity_ids) AND json_type(identity_ids) = 'array'),
  created_at INTEGER NOT NULL,
  unused_expires_at INTEGER NOT NULL,
  expires_at INTEGER,
  first_used_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_device_actor ON device_credentials(actor_id);

CREATE TABLE pairing_requests (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL CHECK(length(code) = 6 AND code NOT GLOB '*[^0-9]*'),
  poll_token_hash TEXT NOT NULL UNIQUE CHECK(length(poll_token_hash) = 64),
  source_hash TEXT NOT NULL,
  client_name TEXT NOT NULL,
  requested_scopes TEXT NOT NULL CHECK(json_valid(requested_scopes) AND json_type(requested_scopes) = 'array'),
  requested_identity_ids TEXT NOT NULL CHECK(json_valid(requested_identity_ids) AND json_type(requested_identity_ids) = 'array'),
  approved_scopes TEXT CHECK(approved_scopes IS NULL OR (json_valid(approved_scopes) AND json_type(approved_scopes) = 'array')),
  approved_identity_ids TEXT CHECK(approved_identity_ids IS NULL OR (json_valid(approved_identity_ids) AND json_type(approved_identity_ids) = 'array')),
  actor_id INTEGER REFERENCES actors(id) ON DELETE CASCADE,
  approved_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending', 'authorized', 'rejected', 'expired', 'consumed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  credential_expires_at INTEGER,
  last_claim_at INTEGER,
  issued_device_id TEXT REFERENCES device_credentials(id) ON DELETE SET NULL
);
-- Expired/consumed requests remain as audit evidence without reserving their display code.
CREATE UNIQUE INDEX idx_live_pairing_code ON pairing_requests(code) WHERE status IN ('pending', 'authorized');
CREATE INDEX idx_pairing_source_created ON pairing_requests(source_hash, created_at);
CREATE INDEX idx_pairing_expiry ON pairing_requests(status, expires_at);
