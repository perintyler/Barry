import crypto from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import cors from "cors";

import { getDb, vaultDatabasePath } from "../../src/db.js";
import { vaultTokenSigningKey } from "../../src/token-signing-key.js";
import { readDaemonConfiguration } from "../../src/daemon-config.js";
import { setupMcp } from "../../src/mcp.js";
import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("vault.api", { transport: "stderr" });


const __dirname = dirname(fileURLToPath(import.meta.url));
// server/src/ -> the bag's src/ui/app.html. The cwd fallback keeps a run from
// the bag directory working; both are checked so neither layout is load-bearing.
const htmlPath = [
  join(__dirname, "..", "..", "src", "ui", "app.html"),
  join(process.cwd(), "src", "ui", "app.html"),
].find((p) => { try { readFileSync(p); return true; } catch { return false; } });
const APP_HTML = htmlPath ? readFileSync(htmlPath, "utf-8") : "<html><body>Vault UI unavailable</body></html>";

// PORT and socket path live in the entrypoint — this module is the request
// handler and never binds anything itself.
const signingKey = vaultTokenSigningKey(join(dirname(vaultDatabasePath), "private", "token-signing-key"));
const daemonConfiguration = await readDaemonConfiguration(vaultDatabasePath);
const registrationSecret = daemonConfiguration.secrets.VAULT_REGISTRATION_SECRET;
/** Registration and full-store backup use separate installation credentials. */
const BACKUP_SECRET = daemonConfiguration.secrets.VAULT_BACKUP_SECRET;
const TOKEN_LIFETIME_SECONDS = 7200;



function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function bufToHex(buf: Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

// Include a unique token ID so simultaneous logins cannot revoke each other when one logs out.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-033
function signJwt(payload: { sub: string; iat: number; exp: number }, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...payload, jti: crypto.randomUUID() })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

/**
 * Whether a presented credential equals the expected one, in time that does not
 * depend on where they differ. Both sides are hashed first, so the comparison
 * is always over equal lengths and the length of the secret does not leak
 * either. A header sent twice arrives as an array and never matches.
 */
function sameSecret(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string" || !expected) return false;
  const digest = (value: string) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(presented), digest(expected));
}

function verifyJwt(token: string, secret: string): { sub: string; iat: number; exp: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const sig = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  if (!sameSecret(parts[2], sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const now = Date.now() / 1000;
    if (!payload || typeof payload.sub !== "string" || !payload.sub
      || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || payload.exp < now || payload.exp - payload.iat > TOKEN_LIFETIME_SECONDS
      || payload.iat > now + 60) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- Rate limiting ---
//
// Count failed authentications only; successful logins do not consume the budget.
// See docs/decisions/0016-vault-daemon-boundaries.md.
//
// Two counters guard each login:
//   - per identifier (the email, or the API key's clientId): the useful
//     signal, cleared by a success so good credentials never throttle
//     themselves;
//   - one global counter, because the identifier is CALLER-CHOSEN. The API-key
//     lookup is by secret hash alone and clientId is checked afterwards, so a
//     guesser could otherwise rotate clientId per request and allocate itself
//     a fresh bucket every time. A success never clears the global counter:
//     a caller holding one valid credential could otherwise interleave a
//     success every few guesses and reset the brake forever.

const RATE_WINDOW_SECONDS = 60;
const FAILURES_PER_IDENTIFIER = 5;
const FAILURES_GLOBAL = 50;
const GLOBAL_FAILURE_KEY = "ratelimit:fail:global";

/** Long identifiers are truncated: the key is attacker-supplied text. */
function failureKey(route: "token" | "api-key", identifier: string): string {
  return `ratelimit:fail:${route}:${identifier.slice(0, 256)}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Seconds until the caller may try again, or null when nothing blocks it.
 * Read-only: checking a limit must not itself count as an attempt.
 */
function secondsUntilAllowed(identifierKey: string): number | null {
  const db = getDb();
  const now = nowSeconds();
  let wait: number | null = null;
  for (const [key, limit] of [
    [identifierKey, FAILURES_PER_IDENTIFIER],
    [GLOBAL_FAILURE_KEY, FAILURES_GLOBAL],
  ] as const) {
    const row = db.prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?").get(key) as
      | { count: number; reset_at: number }
      | undefined;
    if (row && now < row.reset_at && row.count >= limit) {
      wait = Math.max(wait ?? 0, row.reset_at - now);
    }
  }
  return wait;
}

function recordAuthFailure(identifierKey: string): void {
  const db = getDb();
  const now = nowSeconds();
  for (const key of [identifierKey, GLOBAL_FAILURE_KEY]) {
    const row = db.prepare("SELECT reset_at FROM rate_limits WHERE key = ?").get(key) as
      | { reset_at: number }
      | undefined;
    if (!row || now >= row.reset_at) {
      db.prepare("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)").run(
        key,
        now + RATE_WINDOW_SECONDS,
      );
    } else {
      db.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").run(key);
    }
  }
}

/** A success clears the identifier's own counter — never the global one. */
function clearIdentifierFailures(identifierKey: string): void {
  getDb().prepare("DELETE FROM rate_limits WHERE key = ?").run(identifierKey);
}

/**
 * Answer 429 with the wait in BOTH the header and the body. The body is the
 * half clients can read: the socket client adapts replies to
 * `{ ok, status, json() }` and exposes no headers at all.
 */
function refuseRateLimited(res: express.Response, retryAfterSeconds: number): void {
  const seconds = Math.max(1, retryAfterSeconds);
  res.set("Retry-After", String(seconds));
  res.status(429).json({ error: "Too many failed attempts, try again later", retryAfterSeconds: seconds });
}


function getAccountFromAuth(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const payload = verifyJwt(token, signingKey);
  if (!payload) return null;

  const tokenHash = sha256(token);
  const db = getDb();
  const revoked = db.prepare("SELECT 1 FROM revoked_tokens WHERE token_hash = ?").get(tokenHash);
  if (revoked) return null;

  return payload.sub;
}


export const app = express();
app.use(express.json());
// BAG-14: `cors()` reflected any origin. The UI is served same-origin from this
// server, so cross-origin access is not needed; restrict it. `VAULT_UI_ORIGIN`
// (comma-separated) opts specific origins in for a split deployment; absent, no
// cross-origin request is allowed (same-origin fetches do not send Origin and
// are unaffected).
const corsAllowList = (process.env.VAULT_UI_ORIGIN ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: corsAllowList.length > 0 ? corsAllowList : false,
    methods: ["GET", "POST", "PUT", "DELETE"],
  }),
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/** Snapshot through the daemon's live SQLite handle without widening raw-file access; see docs/decisions/0016-vault-daemon-boundaries.md. */
app.post("/api/backup", (req, res) => {
  if (!BACKUP_SECRET || !sameSecret(req.headers["x-backup-secret"], BACKUP_SECRET)) {
    res.status(403).json({ error: "Backup not allowed" });
    return;
  }

  // VACUUM INTO needs a path and refuses to overwrite, so the snapshot is
  // built in the daemon's own directory and streamed out. Randomised because
  // two concurrent backups would otherwise collide on the name.
  const tmpPath = join(
    tmpdir(),
    `vault-snapshot-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`,
  );

  try {
    getDb().exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);

    const body = readFileSync(tmpPath);
    res.set({
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
    });
    res.send(body);
  } catch (error) {
    diagnostics.error("vault.backup_failed", { detail: "[vault] backup failed:", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    // Only if nothing was sent: once the body is streaming, a late failure
    // cannot be turned back into a clean 500.
    if (!res.headersSent) {
      res.status(500).json({ error: `Snapshot failed: ${(error as Error).message}` });
    }
  } finally {
    // The snapshot is the whole database. Never leave it on disk.
    try { unlinkSync(tmpPath); } catch { /* never existed */ }
  }
});

app.get("/", (_req, res) => {
  const nonce = crypto.randomBytes(16).toString("base64");
  const html = APP_HTML.replace("<script>", `<script nonce="${nonce}">`);
  res.set({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.send(html);
});

app.post("/api/accounts/register", (req, res) => {
  if (!registrationSecret || !sameSecret(req.headers["x-registration-secret"], registrationSecret)) {
    res.status(403).json({ error: "Registration not allowed" });
    return;
  }

  const { email, masterPasswordHash, encryptedKey, kdfSalt, publicKey, encryptedPrivateKey } = req.body;
  if (!email || !masterPasswordHash || !encryptedKey) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const salt = kdfSalt ?? bufToHex(crypto.getRandomValues(new Uint8Array(16)));
  const hashForStorage = sha256(masterPasswordHash);

  try {
    db.prepare(
      `INSERT INTO accounts (id, email, master_password_hash, encrypted_key, public_key, encrypted_private_key, kdf_salt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, email.toLowerCase(), hashForStorage, encryptedKey, publicKey ?? null, encryptedPrivateKey ?? null, salt);

    const rawKey = bufToHex(crypto.getRandomValues(new Uint8Array(32)));
    const clientId = `vault.${id.slice(0, 8)}`;
    const keyHash = sha256(rawKey);

    db.prepare("INSERT INTO api_keys (id, account_id, key_hash) VALUES (?, ?, ?)").run(
      crypto.randomUUID(),
      id,
      keyHash,
    );

    res.status(201).json({ id, clientId, clientSecret: rawKey });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("UNIQUE constraint failed") ? 409 : 500;
    res.status(status).json({ error: "Request failed" });
  }
});

/**
 * A deterministic, account-independent salt for an email the vault does not
 * know. BAG-14: returning `null` for unknown accounts and the real salt for
 * known ones let a caller enumerate which emails have accounts. The fake is a
 * stable function of the email (and the server's signing key, so it is not
 * guessable off-box) and sits in the same hex-string shape as a real kdf_salt,
 * so a real and a fake response are indistinguishable to the caller.
 */
function fakeSaltFor(email: string): string {
  return crypto.createHmac("sha256", signingKey).update(`salt:${email}`).digest("hex").slice(0, 32);
}

// Salt lookups are not auth attempts, so they get their own counter rather than
// borrowing the login failure budget. Every request counts; the limit guards
// the enumeration surface the deterministic fake above already blinds.
const SALT_REQUESTS_PER_IDENTIFIER = 30;

function saltRateKey(email: string): string {
  return `ratelimit:salt:${email.slice(0, 256)}`;
}

/** Returns seconds to wait if the salt route is throttled for this email, else null, and counts this request. */
function throttleSaltRequest(email: string): number | null {
  const db = getDb();
  const now = nowSeconds();
  const key = saltRateKey(email);
  const row = db.prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?").get(key) as
    | { count: number; reset_at: number }
    | undefined;
  if (row && now < row.reset_at && row.count >= SALT_REQUESTS_PER_IDENTIFIER) {
    return row.reset_at - now;
  }
  if (!row || now >= row.reset_at) {
    db.prepare("INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)").run(key, now + RATE_WINDOW_SECONDS);
  } else {
    db.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").run(key);
  }
  return null;
}

app.post("/api/auth/salt", (req, res) => {
  const { email } = req.body;
  if (typeof email !== "string" || !email) {
    res.status(400).json({ error: "Missing email" });
    return;
  }

  const normalized = email.toLowerCase();
  const wait = throttleSaltRequest(normalized);
  if (wait !== null) {
    refuseRateLimited(res, wait);
    return;
  }

  const db = getDb();
  const account = db.prepare("SELECT kdf_salt FROM accounts WHERE email = ?").get(normalized) as
    | { kdf_salt: string | null }
    | undefined;

  // Known account with a stored salt → the real salt; otherwise a deterministic
  // fake, so "no such account" and "account with no salt" are not observable.
  res.json({ salt: account?.kdf_salt ?? fakeSaltFor(normalized) });
});

app.post("/api/auth/token", (req, res) => {
  const { email, masterPasswordHash } = req.body;
  if (typeof email !== "string" || typeof masterPasswordHash !== "string" || !email || !masterPasswordHash) {
    res.status(400).json({ error: "Missing credentials" });
    return;
  }

  const limitKey = failureKey("token", email.toLowerCase());
  const wait = secondsUntilAllowed(limitKey);
  if (wait !== null) {
    refuseRateLimited(res, wait);
    return;
  }

  const db = getDb();
  const hashForLookup = sha256(masterPasswordHash);
  const account = db
    .prepare("SELECT id, encrypted_key, kdf_salt FROM accounts WHERE email = ? AND master_password_hash = ?")
    .get(email.toLowerCase(), hashForLookup) as
    | { id: string; encrypted_key: string; kdf_salt: string | null }
    | undefined;

  if (!account) {
    recordAuthFailure(limitKey);
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  clearIdentifierFailures(limitKey);
  const iat = Math.floor(Date.now() / 1000);
  const token = signJwt({ sub: account.id, iat, exp: iat + TOKEN_LIFETIME_SECONDS }, signingKey);
  res.json({ token, encryptedKey: account.encrypted_key, kdfSalt: account.kdf_salt });
});

app.post("/api/auth/api-key", (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (typeof clientId !== "string" || typeof clientSecret !== "string" || !clientId || !clientSecret) {
    res.status(400).json({ error: "Missing credentials" });
    return;
  }

  const limitKey = failureKey("api-key", clientId);
  const wait = secondsUntilAllowed(limitKey);
  if (wait !== null) {
    refuseRateLimited(res, wait);
    return;
  }

  const db = getDb();
  const accountIdPrefix = clientId.replace("vault.", "");
  const keyHash = sha256(clientSecret);

  const apiKey = db
    .prepare(
      `SELECT ak.account_id, a.encrypted_key
       FROM api_keys ak
       JOIN accounts a ON a.id = ak.account_id
       WHERE ak.key_hash = ?`,
    )
    .get(keyHash) as { account_id: string; encrypted_key: string } | undefined;

  if (!apiKey || !apiKey.account_id.startsWith(accountIdPrefix)) {
    recordAuthFailure(limitKey);
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  clearIdentifierFailures(limitKey);
  const iat = Math.floor(Date.now() / 1000);
  const token = signJwt({ sub: apiKey.account_id, iat, exp: iat + TOKEN_LIFETIME_SECONDS }, signingKey);
  res.json({ token, encryptedKey: apiKey.encrypted_key });
});

app.post("/api/auth/logout", (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const tokenHash = sha256(authHeader.slice(7));
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO revoked_tokens (token_hash, expires_at) VALUES (?, datetime('now', ?))").run(
      tokenHash, `+${TOKEN_LIFETIME_SECONDS} seconds`,
    );
  }
  res.json({ ok: true });
});


function requireAuth(req: express.Request, res: express.Response): string | null {
  const accountId = getAccountFromAuth(req.headers.authorization);
  if (!accountId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return accountId;
}

app.post("/api/accounts/api-key", (req, res) => {
  const accountId = requireAuth(req, res);
  if (!accountId) return;

  const db = getDb();
  const rawKey = bufToHex(crypto.getRandomValues(new Uint8Array(32)));
  const keyHash = sha256(rawKey);
  const clientId = `vault.${accountId.slice(0, 8)}`;

  db.prepare("INSERT INTO api_keys (id, account_id, key_hash) VALUES (?, ?, ?)").run(
    crypto.randomUUID(),
    accountId,
    keyHash,
  );

  res.status(201).json({ clientId, clientSecret: rawKey });
});

app.get("/api/items", (req, res) => {
  const accountId = requireAuth(req, res);
  if (!accountId) return;

  const db = getDb();
  const items = db
    .prepare(
      "SELECT id, name, type, username, password, uri, notes, created_at, updated_at FROM items WHERE account_id = ? ORDER BY updated_at DESC",
    )
    .all(accountId);

  res.json({ items });
});

app.post("/api/items", (req, res) => {
  const accountId = requireAuth(req, res);
  if (!accountId) return;

  const { name, type, username, password, uri, notes } = req.body;
  if (!name) {
    res.status(400).json({ error: "Name is required" });
    return;
  }

  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    "INSERT INTO items (id, account_id, name, type, username, password, uri, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, accountId, name, type ?? 1, username ?? null, password ?? null, uri ?? null, notes ?? null);

  res.status(201).json({ id });
});

app.get("/api/items/:id", (req, res) => {
  const accountId = requireAuth(req, res);
  if (!accountId) return;

  const db = getDb();
  const item = db
    .prepare(
      "SELECT id, name, type, username, password, uri, notes, created_at, updated_at FROM items WHERE id = ? AND account_id = ?",
    )
    .get(req.params.id, accountId);

  if (!item) {
    res.status(404).json({ error: "Item not found" });
    return;
  }

  res.json(item);
});

app.put("/api/items/:id", (req, res) => {
  const accountId = requireAuth(req, res);
  if (!accountId) return;

  const sets: string[] = ["updated_at = datetime('now')"];
  const values: (string | null)[] = [];

  for (const field of ["name", "username", "password", "uri", "notes"] as const) {
    if (req.body[field] !== undefined) {
      sets.push(`${field} = ?`);
      values.push(req.body[field] ?? null);
    }
  }

  // Reject empty writes; see docs/decisions/0016-vault-daemon-boundaries.md.
  if (values.length === 0) {
    res.status(400).json({ error: "No updatable field supplied" });
    return;
  }

  values.push(req.params.id, accountId);
  const db = getDb();
  const { changes } = db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ? AND account_id = ?`).run(...values);

  // Missing and foreign-account IDs both return 404; see docs/decisions/0016-vault-daemon-boundaries.md.
  if (changes === 0) {
    res.status(404).json({ error: "Item not found" });
    return;
  }

  res.json({ ok: true });
});

app.delete("/api/items/:id", (req, res) => {
  const accountId = requireAuth(req, res);
  if (!accountId) return;

  const db = getDb();
  const { changes } = db.prepare("DELETE FROM items WHERE id = ? AND account_id = ?").run(req.params.id, accountId);
  if (changes === 0) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  res.json({ ok: true });
});


setupMcp(app, signingKey, {
  ...daemonConfiguration.secrets,
  VAULT_EMAIL: daemonConfiguration.mcp?.email,
  VAULT_CLIENT_ID: daemonConfiguration.mcp?.client_id,
});

