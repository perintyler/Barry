import { acquireVaultOwnership } from "./ownership.js";
import Database from "better-sqlite3";
import { vaultPaths } from "./paths.js";

/**
 * Where the encrypted store lives.
 *
 * The default is the service account's own directory, not `/data` (the old
 * container volume) and not anything under the user's home: a path the invoking
 * user owns can be renamed or replaced by that user whatever the file's own
 * mode says, which would undo the isolation the separate account provides.
 * Expected ownership is `_barryvault:_barryvault`, mode 0750 on the directory:
 * group traverse, so the nightly backup can reach the database as the user.
 */
export const vaultDatabasePath = vaultPaths().database;

let _db: Database.Database | null = null;
let releaseOwnership: (() => void) | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    releaseOwnership = acquireVaultOwnership(vaultDatabasePath);
    try {
      _db = new Database(vaultDatabasePath);
      _db.pragma("journal_mode = WAL");
      _db.pragma("foreign_keys = ON");
      initSchema(_db);
    } catch (error) {
      // A failed SQLite close must retain ownership; another process must not
      // replace a database while this process could still hold its handles.
      try { _db?.close(); } catch (close) { throw new AggregateError([error, close], "Vault initialization and close failed; ownership retained"); }
      _db = null; releaseOwnership(); releaseOwnership = null; throw error;
    }
  }
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      master_password_hash TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      public_key TEXT,
      encrypted_private_key TEXT,
      kdf_salt TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      type INTEGER DEFAULT 1,
      username TEXT,
      password TEXT,
      uri TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      key_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS revoked_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_items_account_id ON items(account_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_account_id ON api_keys(account_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);
    CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);
  `);
}

export function cleanup(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM rate_limits WHERE reset_at < ?").run(now);
  db.prepare("DELETE FROM revoked_tokens WHERE expires_at < datetime('now')").run();
}

/** Close SQLite before releasing the lifetime ownership lock. */
export function closeDb(): void {
  _db?.close(); _db = null;
  releaseOwnership?.(); releaseOwnership = null;
}
