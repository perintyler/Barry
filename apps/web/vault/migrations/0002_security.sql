-- Rate limiting backed by D1 (survives isolate restarts)
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);

-- Token revocation for logout support
CREATE TABLE revoked_tokens (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

-- Per-account random salt for key derivation (replaces email-only salt)
-- NULL means legacy account using email as salt; non-NULL means upgraded
ALTER TABLE accounts ADD COLUMN kdf_salt TEXT;

-- Cleanup index for expired entries
CREATE INDEX idx_rate_limits_reset ON rate_limits(reset_at);
CREATE INDEX idx_revoked_tokens_expires ON revoked_tokens(expires_at);
