import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import crypto from "node:crypto";

// app.ts had no automated coverage before this file — it is normally only
// exercised by hand or through the real daemon. Adding a test here rather
// than skipping it because "nothing else does" would leave the one route
// with the sharpest blast radius (it returns the whole encrypted store)
// unverified by anything except a person remembering to check it by hand.

const registrationCredential = "scratch-registration-credential";
let dir: string;
let configuredSecrets: Record<string, string>;

/** Imports app.ts fresh with the env it requires already set. */
async function loadApp(env: Record<string, string>) {
  vi.resetModules();
  Object.assign(configuredSecrets, env);
  const bindings = Object.keys(configuredSecrets).map(name => `  ${name}: { in: .env }`).join("\n");
  writeFileSync(join(dir, "private", "barry.yaml"), bindings ? `secrets:\n${bindings}\n` : "secrets: {}\n", { mode: 0o600 });
  writeFileSync(join(dir, "private", ".env"), Object.entries(configuredSecrets).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n"), { mode: 0o600 });
  const mod = await import("./app.js");
  return mod.app;
}

function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function request(
  port: number,
  opts: { method: string; path: string; headers?: Record<string, string>; json?: unknown },
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  const payload = opts.json === undefined ? undefined : JSON.stringify(opts.json);
  const headers = payload === undefined ? opts.headers : { "content-type": "application/json", ...opts.headers };
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method, path: opts.path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function jsonOf<T>(res: { body: Buffer }): T {
  return JSON.parse(res.body.toString("utf8")) as T;
}

/** A running app on an ephemeral port, closed after the test. */
const openServers: http.Server[] = [];
async function startApp(env: Record<string, string> = {}): Promise<number> {
  const app = await loadApp(env);
  const server = app.listen(0, "127.0.0.1");
  openServers.push(server);
  return listenEphemeral(server);
}

/**
 * Registers an account. The server treats masterPasswordHash and encryptedKey
 * as opaque strings, so these route tests need no client-side crypto.
 */
async function register(port: number, email: string, masterPasswordHash = "correct-hash") {
  const res = await request(port, {
    method: "POST",
    path: "/api/accounts/register",
    headers: { "x-registration-secret": registrationCredential },
    json: { email, masterPasswordHash, encryptedKey: "enc-key" },
  });
  expect(res.status).toBe(201);
  return jsonOf<{ id: string; clientId: string; clientSecret: string }>(res);
}

function tokenLogin(port: number, email: string, masterPasswordHash: string) {
  return request(port, { method: "POST", path: "/api/auth/token", json: { email, masterPasswordHash } });
}

function apiKeyLogin(port: number, clientId: string, clientSecret: string) {
  return request(port, { method: "POST", path: "/api/auth/api-key", json: { clientId, clientSecret } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vault-app-test-"));
  process.env.VAULT_DB_PATH = join(dir, "vault.db");
  mkdirSync(join(dir, "private"), { mode: 0o700 });
  writeFileSync(join(dir, "private", "token-signing-key"), "the-signing-secret\n", { mode: 0o600 });
  process.env.JWT_SECRET = "unrelated-shell-signing-secret";
  configuredSecrets = { VAULT_REGISTRATION_SECRET: registrationCredential };
  process.env.VAULT_REGISTRATION_SECRET = "unrelated-shell-registration";
  process.env.REGISTRATION_SECRET = "unrelated-retired-registration-value";
  delete process.env.VAULT_BACKUP_SECRET;
});

afterEach(() => {
  for (const server of openServers.splice(0)) server.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VAULT_DB_PATH;
  delete process.env.JWT_SECRET;
  delete process.env.VAULT_REGISTRATION_SECRET;
  delete process.env.REGISTRATION_SECRET;
  delete process.env.VAULT_BACKUP_SECRET;
});

describe("POST /api/accounts/register", () => {
  const payload = { email: "blocked@example.com", masterPasswordHash: "hash", encryptedKey: "key" };
  it("fails closed without a canonical registration credential despite a retired alias", async () => {
    delete configuredSecrets.VAULT_REGISTRATION_SECRET;
    const port = await startApp();
    const response = await request(port, { method: "POST", path: "/api/accounts/register", headers: { "x-registration-secret": "unrelated-retired-registration-value" }, json: payload });
    expect(response.status).toBe(403);
    expect(existsSync(join(dir, "vault.db"))).toBe(false);
  });
  it("rejects absent and incorrect credentials before opening the database", async () => {
    const port = await startApp();
    const attempts: Record<string, string>[] = [{}, { "x-registration-secret": "wrong" }];
    for (const headers of attempts) {
      expect((await request(port, { method: "POST", path: "/api/accounts/register", headers, json: payload })).status).toBe(403);
    }
    expect(existsSync(join(dir, "vault.db"))).toBe(false);
    await register(port, "allowed@example.com");
  });
});

describe("POST /api/backup", () => {
  it("fails closed when VAULT_BACKUP_SECRET is unset", async () => {
    const app = await loadApp({});
    const server = app.listen(0, "127.0.0.1");
    const port = await new Promise<number>((resolve) =>
      server.on("listening", () => resolve((server.address() as { port: number }).port)),
    );
    try {
      const res = await request(port, {
        method: "POST",
        path: "/api/backup",
        headers: { "x-backup-secret": "anything" },
      });
      expect(res.status).toBe(403);
    } finally {
      server.close();
    }
  });

  it("rejects a wrong secret", async () => {
    const app = await loadApp({ VAULT_BACKUP_SECRET: "correct-secret" });
    const port = await listenEphemeral(app.listen(0, "127.0.0.1"));
    const res = await request(port, {
      method: "POST",
      path: "/api/backup",
      headers: { "x-backup-secret": "wrong-secret" },
    });
    expect(res.status).toBe(403);
  });

  it("streams back a snapshot that opens and carries the WAL, then leaves nothing behind", async () => {
    const app = await loadApp({ VAULT_BACKUP_SECRET: "correct-secret" });
    // getDb() creates the schema on first call, inside app's own module graph —
    // reach it through the same import so we write through the SAME connection
    // the route will VACUUM, matching what the real daemon does.
    const { getDb } = await import("../../src/db.js");
    const db = getDb();
    db.prepare("insert into accounts (id, email, master_password_hash, encrypted_key, kdf_salt) values (?,?,?,?,?)")
      .run("acct-1", "user@example.com", "hash", "enc-key", "salt");
    // Left un-checkpointed on purpose: this is the state a running vault is in.

    const port = await listenEphemeral(app.listen(0, "127.0.0.1"));
    const res = await request(port, {
      method: "POST",
      path: "/api/backup",
      headers: { "x-backup-secret": "correct-secret" },
    });

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);

    const snapPath = join(dir, "snapshot-received.db");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(snapPath, res.body);

    const snap = new Database(snapPath, { readonly: true });
    const ok = (snap.pragma("integrity_check") as Array<{ integrity_check: string }>)[0].integrity_check;
    expect(ok).toBe("ok");
    const row = snap.prepare("select count(*) c from accounts").get() as { c: number };
    expect(row.c).toBe(1);
    snap.close();
  });

  it("leaves no snapshot file behind in the daemon's temp directory", async () => {
    const app = await loadApp({ VAULT_BACKUP_SECRET: "correct-secret" });
    const { readdirSync } = await import("node:fs");
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("vault-snapshot-"));

    const port = await listenEphemeral(app.listen(0, "127.0.0.1"));
    await request(port, { method: "POST", path: "/api/backup", headers: { "x-backup-secret": "correct-secret" } });

    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("vault-snapshot-"));
    expect(after).toEqual(before);
  });
});

describe("credential comparisons", () => {
  // The signature and the two installation credentials were compared with
  // `!==`, which returns at the first differing byte. These pin the behaviour
  // of the constant-time replacement: a forgery of any length is a refusal,
  // never a crash from comparing unequal lengths.
  it("refuses a token whose signature is altered, truncated, or extended", async () => {
    const port = await startApp();
    const acct = await register(port, "forger@example.com");
    const token = jsonOf<{ token: string }>(await apiKeyLogin(port, acct.clientId, acct.clientSecret)).token;
    const [header, body, sig] = token.split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const items = (bearer: string) => request(port, { method: "GET", path: "/api/items", headers: { Authorization: `Bearer ${bearer}` } });
    expect((await items(token)).status).toBe(200);
    for (const forged of [flipped, sig.slice(0, -1), `${sig}A`, ""]) {
      expect((await items(`${header}.${body}.${forged}`)).status).toBe(401);
    }
  });

  it("compares each credential in constant time", async () => {
    const port = await startApp({ VAULT_BACKUP_SECRET: "backup-credential" });
    const acct = await register(port, "timing@example.com");
    const token = jsonOf<{ token: string }>(await apiKeyLogin(port, acct.clientId, acct.clientSecret)).token;
    const compared = vi.spyOn(crypto, "timingSafeEqual");
    try {
      await request(port, { method: "GET", path: "/api/items", headers: { Authorization: `Bearer ${token}` } });
      expect(compared).toHaveBeenCalledTimes(1);
      await request(port, { method: "POST", path: "/api/backup", headers: { "x-backup-secret": "wrong" } });
      expect(compared).toHaveBeenCalledTimes(2);
      await request(port, { method: "POST", path: "/api/accounts/register", headers: { "x-registration-secret": "wrong" }, json: {} });
      expect(compared).toHaveBeenCalledTimes(3);
    } finally {
      compared.mockRestore();
    }
  });

  it("refuses a backup credential that differs only in length", async () => {
    const port = await startApp({ VAULT_BACKUP_SECRET: "backup-credential" });
    for (const presented of ["backup-credentia", "backup-credentialX"]) {
      const res = await request(port, { method: "POST", path: "/api/backup", headers: { "x-backup-secret": presented } });
      expect(res.status).toBe(403);
    }
  });
});

describe("sessions logged in at the same moment", () => {
  // Logout revokes by token hash, and a token was only `sub` + `exp`: two
  // logins to one account in the same second got the same token, so either
  // session logging out revoked the other — which then failed with 401.
  it("get different tokens, so one logging out leaves the other working", async () => {
    const port = await startApp();
    const acct = await register(port, "owner@example.com");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let first: string;
    let second: string;
    try {
      first = jsonOf<{ token: string }>(await apiKeyLogin(port, acct.clientId, acct.clientSecret)).token;
      second = jsonOf<{ token: string }>(await apiKeyLogin(port, acct.clientId, acct.clientSecret)).token;
    } finally {
      clock.mockRestore();
    }
    expect(first).not.toBe(second);

    const logout = await request(port, { method: "POST", path: "/api/auth/logout", headers: { Authorization: `Bearer ${first}` } });
    expect(logout.status).toBe(200);
    const items = (token: string) => request(port, { method: "GET", path: "/api/items", headers: { Authorization: `Bearer ${token}` } });
    expect((await items(first)).status).toBe(401);
    expect((await items(second)).status).toBe(200);
  });
});

describe("login rate limiting — only failures count", () => {
  it("never throttles successful logins (the lockout this limiter used to cause)", async () => {
    // The old limiter counted every allowed request, so the 6th successful
    // vault open inside a minute got a 429 and a session started without its
    // secrets. Twenty in a row must all succeed, on both routes.
    const port = await startApp();
    const acct = await register(port, "owner@example.com");
    for (let i = 0; i < 20; i++) {
      expect((await apiKeyLogin(port, acct.clientId, acct.clientSecret)).status).toBe(200);
      expect((await tokenLogin(port, "owner@example.com", "correct-hash")).status).toBe(200);
    }
  });

  it("refuses the 6th consecutive failure for one identifier, even with the right credentials", async () => {
    const port = await startApp();
    const acct = await register(port, "owner@example.com");
    for (let i = 0; i < 5; i++) {
      expect((await apiKeyLogin(port, acct.clientId, "wrong-secret")).status).toBe(401);
    }
    expect((await apiKeyLogin(port, acct.clientId, "wrong-secret")).status).toBe(429);
    // Brute-force protection must hold against the eventual right guess too.
    expect((await apiKeyLogin(port, acct.clientId, acct.clientSecret)).status).toBe(429);
  });

  it("a success clears the identifier's counter, so 4 failures + success + 5 failures stays unlocked", async () => {
    const port = await startApp();
    await register(port, "owner@example.com");
    for (let i = 0; i < 4; i++) expect((await tokenLogin(port, "owner@example.com", "nope")).status).toBe(401);
    expect((await tokenLogin(port, "owner@example.com", "correct-hash")).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await tokenLogin(port, "owner@example.com", "nope")).status).toBe(401);
    expect((await tokenLogin(port, "owner@example.com", "nope")).status).toBe(429);
  });

  it("keys token logins by email case-insensitively", async () => {
    const port = await startApp();
    await register(port, "owner@example.com");
    for (let i = 0; i < 5; i++) expect((await tokenLogin(port, "Owner@Example.com", "nope")).status).toBe(401);
    expect((await tokenLogin(port, "owner@example.com", "correct-hash")).status).toBe(429);
  });

  it("gives identifiers independent buckets — one locked account does not lock another", async () => {
    const port = await startApp();
    const a = await register(port, "a@example.com");
    const b = await register(port, "b@example.com");
    for (let i = 0; i < 6; i++) await apiKeyLogin(port, a.clientId, "wrong");
    expect((await apiKeyLogin(port, a.clientId, a.clientSecret)).status).toBe(429);
    expect((await apiKeyLogin(port, b.clientId, b.clientSecret)).status).toBe(200);
  });

  it("cannot be dodged by rotating clientId — the global failure counter still trips", async () => {
    // The API-key lookup is by secret hash, and clientId is caller-chosen. A
    // guesser inventing a new clientId per request gets a fresh per-identifier
    // bucket every time; only the global counter stops it.
    const port = await startApp();
    for (let i = 0; i < 50; i++) {
      expect((await apiKeyLogin(port, `vault.guess${i}`, "wrong")).status).toBe(401);
    }
    expect((await apiKeyLogin(port, "vault.never-seen", "wrong")).status).toBe(429);
  });

  it("a success does NOT clear the global counter — interleaved successes cannot reset the brake", async () => {
    const port = await startApp();
    const acct = await register(port, "owner@example.com");
    for (let i = 0; i < 49; i++) await apiKeyLogin(port, `vault.guess${i}`, "wrong");
    expect((await apiKeyLogin(port, acct.clientId, acct.clientSecret)).status).toBe(200);
    expect((await apiKeyLogin(port, "vault.guess-final", "wrong")).status).toBe(401); // the 50th failure
    expect((await apiKeyLogin(port, "vault.guess-after", "wrong")).status).toBe(429);
  });

  it("lets the identifier back in once the window expires", async () => {
    const port = await startApp();
    const acct = await register(port, "owner@example.com");
    for (let i = 0; i < 6; i++) await apiKeyLogin(port, acct.clientId, "wrong");
    expect((await apiKeyLogin(port, acct.clientId, acct.clientSecret)).status).toBe(429);

    // Expire every window through the routes' own connection instead of sleeping 60s.
    const { getDb } = await import("../../src/db.js");
    getDb().prepare("UPDATE rate_limits SET reset_at = ?").run(Math.floor(Date.now() / 1000) - 1);

    expect((await apiKeyLogin(port, acct.clientId, acct.clientSecret)).status).toBe(200);
  });

  it("reports the wait in the JSON body (readable over the socket) and in Retry-After", async () => {
    const port = await startApp();
    await register(port, "owner@example.com");
    for (let i = 0; i < 5; i++) await tokenLogin(port, "owner@example.com", "nope");
    const res = await tokenLogin(port, "owner@example.com", "nope");
    expect(res.status).toBe(429);
    const body = jsonOf<{ retryAfterSeconds: unknown }>(res);
    expect(typeof body.retryAfterSeconds).toBe("number");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(Number(res.headers["retry-after"])).toBe(body.retryAfterSeconds);
  });

  it("rejects non-string credentials with 400 instead of crashing on .replace/.toLowerCase", async () => {
    const port = await startApp();
    expect((await request(port, { method: "POST", path: "/api/auth/api-key", json: { clientId: 7, clientSecret: "x" } })).status).toBe(400);
    expect((await request(port, { method: "POST", path: "/api/auth/token", json: { email: ["a"], masterPasswordHash: "x" } })).status).toBe(400);
  });
});

describe("item writes report what actually happened", () => {
  async function loggedIn(port: number, email: string) {
    await register(port, email);
    const res = await tokenLogin(port, email, "correct-hash");
    const { token } = jsonOf<{ token: string }>(res);
    return { Authorization: `Bearer ${token}` };
  }

  async function createItem(port: number, auth: Record<string, string>) {
    const res = await request(port, { method: "POST", path: "/api/items", headers: auth, json: { name: "n", password: "p" } });
    expect(res.status).toBe(201);
    return jsonOf<{ id: string }>(res).id;
  }

  it("PUT succeeds on the caller's own item and actually changes it", async () => {
    const port = await startApp();
    const auth = await loggedIn(port, "a@example.com");
    const id = await createItem(port, auth);
    expect((await request(port, { method: "PUT", path: `/api/items/${id}`, headers: auth, json: { password: "p2" } })).status).toBe(200);
    const item = jsonOf<{ password: string }>(await request(port, { method: "GET", path: `/api/items/${id}`, headers: auth }));
    expect(item.password).toBe("p2");
  });

  it("PUT on a nonexistent id is 404, not ok", async () => {
    const port = await startApp();
    const auth = await loggedIn(port, "a@example.com");
    const res = await request(port, { method: "PUT", path: "/api/items/no-such-id", headers: auth, json: { password: "p2" } });
    expect(res.status).toBe(404);
  });

  it("PUT on ANOTHER account's item is 404 and leaves it untouched", async () => {
    const port = await startApp();
    const owner = await loggedIn(port, "owner@example.com");
    const other = await loggedIn(port, "other@example.com");
    const id = await createItem(port, owner);
    expect((await request(port, { method: "PUT", path: `/api/items/${id}`, headers: other, json: { password: "hijacked" } })).status).toBe(404);
    const item = jsonOf<{ password: string }>(await request(port, { method: "GET", path: `/api/items/${id}`, headers: owner }));
    expect(item.password).toBe("p");
  });

  it("PUT naming no updatable field is 400, not a silent touch", async () => {
    const port = await startApp();
    const auth = await loggedIn(port, "a@example.com");
    const id = await createItem(port, auth);
    expect((await request(port, { method: "PUT", path: `/api/items/${id}`, headers: auth, json: { nonsense: "x" } })).status).toBe(400);
  });

  it("DELETE on a nonexistent or foreign id is 404, and a real delete is ok exactly once", async () => {
    const port = await startApp();
    const owner = await loggedIn(port, "owner@example.com");
    const other = await loggedIn(port, "other@example.com");
    const id = await createItem(port, owner);
    expect((await request(port, { method: "DELETE", path: "/api/items/no-such-id", headers: owner })).status).toBe(404);
    expect((await request(port, { method: "DELETE", path: `/api/items/${id}`, headers: other })).status).toBe(404);
    expect((await request(port, { method: "DELETE", path: `/api/items/${id}`, headers: owner })).status).toBe(200);
    expect((await request(port, { method: "DELETE", path: `/api/items/${id}`, headers: owner })).status).toBe(404);
  });
});

it("keeps issued tokens valid after reopening the app with different shell credentials", async () => {
  const first = await startApp();
  await register(first, "restart@example.com");
  const login = await tokenLogin(first, "restart@example.com", "correct-hash");
  expect(login.status).toBe(200);
  const { token } = jsonOf<{ token: string }>(login);
  // A real restart releases the previous owner before the replacement opens:
  // the lifetime ownership lock admits one holder at a time.
  (await import("../../src/db.js")).closeDb();
  process.env.JWT_SECRET = "different-unrelated-shell-value";
  const second = await startApp();
  const response = await request(second, { method: "GET", path: "/api/items", headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
});

describe("the /mcp bearer is not the JWT signing secret", () => {
  // The MCP path holds decrypted item keys. Its bearer used to fall back to
  // JWT_SECRET itself, so anyone holding it could also forge session JWTs for
  // any account. It is now derived, and the raw signing secret must not open it.
  const mcpPost = (port: number, token: string) =>
    request(port, {
      method: "POST",
      path: "/mcp",
      headers: { Authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      json: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

  afterEach(() => {
    delete process.env.VAULT_MCP_TOKEN;
  });

  it("refuses the raw JWT_SECRET as a bearer when no dedicated token is set", async () => {
    const port = await startApp();
    expect((await mcpPost(port, "the-signing-secret")).status).toBe(401);
  });

  it("uses the persisted signing key rather than an ambient JWT_SECRET", async () => {
    const { deriveMcpToken } = await import("../../src/mcp-token.js");
    const port = await startApp();
    const derived = deriveMcpToken("the-signing-secret");
    expect(derived).not.toBe("the-signing-secret");
    expect((await mcpPost(port, derived)).status).not.toBe(401);
    expect((await mcpPost(port, deriveMcpToken("unrelated-shell-signing-secret"))).status).toBe(401);
  });

  it("prefers a dedicated VAULT_MCP_TOKEN, and then the derived value no longer works", async () => {
    const { deriveMcpToken } = await import("../../src/mcp-token.js");
    const port = await startApp({ VAULT_MCP_TOKEN: "dedicated-token" });
    expect((await mcpPost(port, "dedicated-token")).status).not.toBe(401);
    expect((await mcpPost(port, deriveMcpToken("the-signing-secret"))).status).toBe(401);
    expect((await mcpPost(port, "the-signing-secret")).status).toBe(401);
  });

  it("refuses a missing or empty bearer", async () => {
    const port = await startApp();
    expect((await mcpPost(port, "")).status).toBe(401);
  });
});

describe("token lifetime", () => {
  function forge(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.createHmac("sha256", "the-signing-secret").update(`${header}.${body}`).digest("base64url");
    return `${header}.${body}.${signature}`;
  }
  it("issues both login tokens with an integer iat and a two-hour lifetime", async () => {
    const port = await startApp(), account = await register(port, "lifetime@example.com");
    for (const login of [await tokenLogin(port, "lifetime@example.com", "correct-hash"), await apiKeyLogin(port, account.clientId, account.clientSecret)]) {
      const { token } = jsonOf<{ token: string }>(login);
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      expect(Number.isSafeInteger(payload.iat)).toBe(true);
      expect(payload.exp - payload.iat).toBe(7200);
    }
  });
  it("rejects signed tokens whose fields exceed the lifetime rules and accepts valid forgeries", async () => {
    const port = await startApp(), account = await register(port, "forged-lifetime@example.com");
    const now = Math.floor(Date.now() / 1000), valid = { sub: account.id, iat: now - 60, exp: now - 60 + 7200 };
    const items = (payload: Record<string, unknown>) => request(port, { method: "GET", path: "/api/items", headers: { Authorization: `Bearer ${forge(payload)}` } });
    for (const payload of [
      { ...valid, exp: now + 30 * 86400 }, { ...valid, iat: now + 3600, exp: now + 10800 },
      { sub: account.id, exp: now + 7200 }, { sub: account.id, iat: now },
      { ...valid, sub: "" }, { ...valid, sub: 1 }, { ...valid, iat: now + 0.5 }, { ...valid, exp: now + 0.5 },
      { ...valid, iat: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, exp: Number.MAX_SAFE_INTEGER + 1 },
    ]) expect((await items(payload)).status).toBe(401);
    expect((await items(valid)).status).toBe(200);
    expect((await items({ sub: account.id, iat: now + 30, exp: now + 7230 })).status).toBe(200);
    const clock = vi.spyOn(Date, "now").mockReturnValue((now + 7201) * 1000);
    try { expect((await items(valid)).status).toBe(401); } finally { clock.mockRestore(); }
  });
});

describe("BAG-14: salt enumeration, rate limit, and CORS", () => {
  it("returns a non-null salt for an unknown account, indistinguishable in shape from a real one", async () => {
    const port = await startApp();
    const unknown = jsonOf<{ salt: string | null }>(
      await request(port, { method: "POST", path: "/api/auth/salt", json: { email: "ghost@example.com" } }),
    );
    expect(unknown.salt).not.toBeNull();
    expect(unknown.salt).toMatch(/^[a-f0-9]{32}$/);
  });

  it("gives the same fake salt for the same unknown email every time (deterministic)", async () => {
    const port = await startApp();
    const ask = () =>
      request(port, { method: "POST", path: "/api/auth/salt", json: { email: "ghost@example.com" } });
    const a = jsonOf<{ salt: string }>(await ask());
    const b = jsonOf<{ salt: string }>(await ask());
    expect(a.salt).toBe(b.salt);
  });

  it("returns the account's real salt for a known email, and it differs from the fake", async () => {
    const port = await startApp();
    await register(port, "known@example.com");
    const known = jsonOf<{ salt: string | null }>(
      await request(port, { method: "POST", path: "/api/auth/salt", json: { email: "known@example.com" } }),
    );
    const unknown = jsonOf<{ salt: string | null }>(
      await request(port, { method: "POST", path: "/api/auth/salt", json: { email: "nobody@example.com" } }),
    );
    expect(known.salt).not.toBeNull();
    expect(known.salt).not.toBe(unknown.salt);
  });

  it("rejects a missing email with 400", async () => {
    const port = await startApp();
    expect(
      (await request(port, { method: "POST", path: "/api/auth/salt", json: {} })).status,
    ).toBe(400);
  });

  it("rate-limits the salt route after its per-identifier budget", async () => {
    const port = await startApp();
    // Budget is 30 per window; the 31st for one email is throttled.
    for (let i = 0; i < 30; i++) {
      expect(
        (await request(port, { method: "POST", path: "/api/auth/salt", json: { email: "flood@example.com" } })).status,
      ).toBe(200);
    }
    const limited = await request(port, { method: "POST", path: "/api/auth/salt", json: { email: "flood@example.com" } });
    expect(limited.status).toBe(429);
    // A different email still has its own budget.
    expect(
      (await request(port, { method: "POST", path: "/api/auth/salt", json: { email: "other@example.com" } })).status,
    ).toBe(200);
  });

  it("does not reflect an arbitrary cross-origin in Access-Control-Allow-Origin", async () => {
    const port = await startApp();
    const res = await request(port, {
      method: "GET",
      path: "/health",
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });
});
