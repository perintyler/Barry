import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getIdentitiesSqlite, closeIdentitiesDb } from "./identities-db.js";
import { DeviceStore, DevicePairingError, type PairingClaim } from "./devices.js";
import { hasIdentityGrant, hasScope } from "@barry-rocks/sdk/internal/auth";

let dir: string;
let now: number;
let store: DeviceStore;
let previousDb: string | undefined;
beforeEach(() => {
  closeIdentitiesDb();
  dir = mkdtempSync(join(tmpdir(), "barry-device-store-"));
  previousDb = process.env.BARRY_IDENTITIES_DB;
  process.env.BARRY_IDENTITIES_DB = join(dir, "identities.db");
  now = 1_000_000;
  const db = getIdentitiesSqlite();
  db.prepare("INSERT INTO actors (id, token, type, name) VALUES (1, 'actor-one', 'user', 'one'), (2, 'actor-two', 'user', 'two')").run();
  db.prepare("INSERT INTO identities (id, token, actor_id, name) VALUES (1, 'identity-one', 1, 'one'), (2, 'identity-two', 2, 'two'), (3, 'identity-three', 1, 'three')").run();
  store = new DeviceStore(db, () => now);
});
afterEach(() => {
  closeIdentitiesDb();
  if (previousDb === undefined) delete process.env.BARRY_IDENTITIES_DB; else process.env.BARRY_IDENTITIES_DB = previousDb;
  rmSync(dir, { recursive: true, force: true });
});
const input = () => ({ clientName: "Test phone", requestedScopes: ["sessions:read", "sessions:turn"] as const, requestedIdentityIds: [1, 3] });
function request(source = "source-one") { const requested = input(); return store.request({ ...requested, requestedScopes: [...requested.requestedScopes] }, source); }
function issued(options: { expiresAt?: number } = {}): Extract<PairingClaim, { status: "authorized" }> {
  const pending = request();
  store.authorize(pending.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [1], ...options });
  const claimed = store.claim(pending.pollToken);
  if (claimed.status !== "authorized") throw new Error("Expected a claimed fixture credential");
  return claimed;
}
function code(action: () => unknown, expected: string): void {
  try { action(); throw new Error("Expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(DevicePairingError); expect((error as DevicePairingError).code).toBe(expected); }
}

describe("device pairing storage", () => {
  it("stores only hash verifiers and preserves the approved reduced grant", () => {
    const pending = request();
    expect(pending.pairingCode).toMatch(/^\d{3}-\d{3}$/);
    expect(pending.pollToken).toMatch(/^barry_pr_[A-Za-z0-9_-]{32}$/);
    expect(pending.expiresAt).toBe(now + 300_000);
    expect(store.pending()).toEqual([expect.objectContaining({ clientName: "Test phone", requestedIdentityIds: [1, 3] })]);
    store.authorize(pending.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [1] });
    const result = store.claim(pending.pollToken);
    expect(result).toMatchObject({ status: "authorized", scopes: ["sessions:read"], identityIds: [1] });
    if (result.status !== "authorized") throw new Error("Expected fixture issuance");
    expect(result.deviceToken).toMatch(/^barry_dt_[A-Za-z0-9_-]{32}$/);
    expect(store.verify(result.deviceToken)).toEqual({ kind: "device", actorId: 1, credentialId: result.deviceId, scopes: ["sessions:read"], identityIds: [1] });
    const db = getIdentitiesSqlite();
    const rows = JSON.stringify([db.prepare("SELECT * FROM pairing_requests").all(), db.prepare("SELECT * FROM device_credentials").all()]);
    expect(rows).not.toContain(pending.pollToken);
    expect(rows).not.toContain(result.deviceToken);
    const audit = db.prepare("SELECT actor_id, approved_at, approved_scopes, approved_identity_ids, issued_device_id FROM pairing_requests").get();
    expect(audit).toMatchObject({ actor_id: 1, approved_at: now, approved_scopes: '["sessions:read"]', approved_identity_ids: '[1]', issued_device_id: result.deviceId });
    db.pragma("wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(join(dir, "identities.db"));
    expect(bytes.includes(Buffer.from(pending.pollToken))).toBe(false);
    expect(bytes.includes(Buffer.from(result.deviceToken))).toBe(false);
  });

  it("never issues twice and identifies a lost successful claim as consumed", () => {
    const pending = request();
    store.authorize(pending.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [1] });
    expect(store.claim(pending.pollToken).status).toBe("authorized");
    expect(store.claim(pending.pollToken)).toEqual({ status: "consumed" });
    expect(getIdentitiesSqlite().prepare("SELECT COUNT(*) AS count FROM device_credentials").get()).toEqual({ count: 1 });
  });

  it("rolls back issuance if consuming the request fails", () => {
    const pending = request();
    store.authorize(pending.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [1] });
    const db = getIdentitiesSqlite();
    db.exec("CREATE TRIGGER fail_consume BEFORE UPDATE OF status ON pairing_requests WHEN NEW.status = 'consumed' BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END;");
    expect(() => store.claim(pending.pollToken)).toThrow("fixture refusal");
    expect(db.prepare("SELECT COUNT(*) AS count FROM device_credentials").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT status FROM pairing_requests").get()).toEqual({ status: "authorized" });
    db.exec("DROP TRIGGER fail_consume");
    expect(store.claim(pending.pollToken).status).toBe("authorized");
  });

  it("prevents approval from expanding scopes or target identities", () => {
    const pending = request();
    code(() => store.authorize(pending.pairingCode, 1, { scopes: ["sessions:write"], identityIds: [1] }), "grant_would_expand_request");
    code(() => store.authorize(pending.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [2] }), "grant_would_expand_request");
    expect(store.pending()).toHaveLength(1);
  });

  it("refuses another actor's identity and an unknown operator", () => {
    const pending = store.request({ clientName: "Phone", requestedScopes: ["sessions:read"], requestedIdentityIds: [2] }, "source");
    code(() => store.authorize(pending.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [2] }), "identity_grant_denied");
    code(() => store.authorize(pending.pairingCode, 99, null), "operator_denied");
    expect(store.pending()).toHaveLength(1);
  });

  it("records rejection authority and never authorizes a rejected request", () => {
    const pending = request();
    expect(store.authorize(pending.pairingCode, 1, null)).toEqual({ status: "rejected", clientName: "Test phone" });
    expect(store.claim(pending.pollToken)).toEqual({ status: "rejected" });
    code(() => store.authorize(pending.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [1] }), "pairing_unavailable");
    expect(getIdentitiesSqlite().prepare("SELECT actor_id, approved_at FROM pairing_requests").get()).toEqual({ actor_id: 1, approved_at: now });
  });

  it("enforces expiry during authorization and claim", () => {
    const pending = request();
    now += 300_000;
    code(() => store.authorize(pending.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [1] }), "pairing_unavailable");
    expect(store.claim(pending.pollToken)).toEqual({ status: "expired" });
    expect(store.pending()).toEqual([]);
  });

  it("cannot approve an already decided request a second time", () => {
    const pending = request();
    store.authorize(pending.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [1] });
    code(() => store.authorize(pending.pairingCode, 1, { scopes: ["sessions:turn"], identityIds: [3] }), "pairing_already_decided");
    expect(store.claim(pending.pollToken)).toMatchObject({ scopes: ["sessions:read"], identityIds: [1] });
  });

  it("reserves display codes only while live and keeps old poll verifiers expired", () => {
    const first = request("first-source");
    const second = request("second-source");
    const db = getIdentitiesSqlite();
    const code = first.pairingCode.replace("-", "");
    expect(() => db.prepare("UPDATE pairing_requests SET code = ? WHERE id = ?").run(code, second.requestId)).toThrow("UNIQUE");
    now += 300_000;
    expect(store.pending()).toEqual([]);
    const third = request("third-source");
    db.prepare("UPDATE pairing_requests SET code = ? WHERE id = ?").run(code, third.requestId);
    store.authorize(first.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [1] });
    expect(store.claim(first.pollToken)).toEqual({ status: "expired" });
    expect(store.claim(third.pollToken)).toMatchObject({ status: "authorized", identityIds: [1] });
  });

  it("refuses a grant whose ownership changes before claim", () => {
    const pending = request();
    store.authorize(pending.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [1] });
    getIdentitiesSqlite().prepare("UPDATE identities SET actor_id = 2 WHERE id = 1").run();
    code(() => store.claim(pending.pollToken), "identity_grant_denied");
    expect(getIdentitiesSqlite().prepare("SELECT COUNT(*) AS count FROM device_credentials").get()).toEqual({ count: 0 });
  });

  it("throttles polling per request and supplies a bounded retry delay", () => {
    const pending = request();
    expect(store.claim(pending.pollToken)).toEqual({ status: "pending" });
    try { store.claim(pending.pollToken); throw new Error("Expected refusal"); }
    catch (error) { expect(error).toMatchObject({ code: "claim_rate_limited", status: 429, retryAfter: 2 }); }
    now += 1_500;
    expect(store.claim(pending.pollToken)).toEqual({ status: "pending" });
  });

  it("bounds both allocation rate and outstanding requests for a source", () => {
    for (let i = 0; i < 5; i++) request();
    code(() => request(), "pairing_rate_limited");
    now += 60_001;
    code(() => request(), "pairing_rate_limited");
    now += 300_000;
    expect(request().pollToken).toMatch(/^barry_pr_/);
  });

  it("bounds outstanding allocations across sources", () => {
    for (let i = 0; i < 100; i++) request(`source-${i}`);
    code(() => request("another-source"), "pairing_rate_limited");
    now += 300_000;
    expect(request("another-source").expiresIn).toBe(300);
  });

  it("rejects unknown/admin scopes, duplicate grants and incomplete sharing grants", () => {
    for (const scopes of [["admin"], ["unknown"], ["artifacts:share"], ["sessions:read", "sessions:read"]]) {
      code(() => store.request({ clientName: "Phone", requestedScopes: scopes as never, requestedIdentityIds: [1] }, "source"), "invalid_device_grant");
    }
    code(() => store.request({ clientName: "Phone", requestedScopes: ["sessions:read"], requestedIdentityIds: [1, 1] }, "source"), "invalid_device_grant");
  });

  it("refuses invalid codes and wrong polling verifiers without disclosing requests", () => {
    request();
    code(() => store.authorize("invalid", 1, null), "invalid_pairing_code");
    code(() => store.claim(`barry_pr_${"a".repeat(32)}`), "invalid_poll_token");
    code(() => store.claim("private-invalid-token"), "invalid_poll_token");
    expect(store.verify("private-invalid-token")).toBeNull();
  });

  it("expires an unused issued token after ten minutes", () => {
    const result = issued();
    now += 600_000;
    expect(store.verify(result.deviceToken)).toBeNull();
    expect(store.list(1)[0]?.firstUsedAt).toBeNull();
  });

  it("establishes a token on first use and throttles usage timestamps", () => {
    const result = issued();
    const principal = store.verify(result.deviceToken)!;
    expect(hasScope(principal, "sessions:read")).toBe(true);
    expect(hasScope(principal, "sessions:write")).toBe(false);
    expect(hasIdentityGrant(principal, 1)).toBe(true);
    expect(hasIdentityGrant(principal, 3)).toBe(false);
    const firstUse = now;
    now += 500;
    expect(store.verify(result.deviceToken)).toEqual(principal);
    expect(store.list(1)[0]).toMatchObject({ firstUsedAt: firstUse, lastUsedAt: firstUse });
    now += 600_000;
    expect(store.verify(result.deviceToken)).toEqual(principal);
    expect(store.list(1)[0]).toMatchObject({ firstUsedAt: firstUse, lastUsedAt: now });
  });

  it("enforces a configured credential expiry and actor-scoped revocation", () => {
    const result = issued({ expiresAt: now + 1_000 });
    expect(store.revoke(2, result.deviceId)).toBe(false);
    expect(store.verify(result.deviceToken)).not.toBeNull();
    now += 1_000;
    expect(store.verify(result.deviceToken)).toBeNull();
    expect(store.revoke(1, result.deviceId)).toBe(true);
    expect(store.revoke(1, result.deviceId)).toBe(true);
    expect(store.list(1)[0]?.revokedAt).toBe(now);
  });

  it("revalidates an authenticated snapshot without updating usage timestamps or establishing an unused token", () => {
    const result = issued();
    const snapshot = { kind: "device" as const, credentialId: result.deviceId, actorId: 1, scopes: ["sessions:read" as const], identityIds: [1] };
    expect(store.revalidate(snapshot)).toBeNull();
    const principal = store.verify(result.deviceToken)!;
    const changes = getIdentitiesSqlite().prepare("SELECT total_changes() AS n").get();
    now += 600_000;
    const current = store.revalidate(principal);
    expect(current).toEqual(principal);
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current?.scopes)).toBe(true);
    expect(getIdentitiesSqlite().prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(store.list(1)[0]).toMatchObject({ firstUsedAt: now - 600_000, lastUsedAt: now - 600_000 });
  });

  it("rejects revoked, expired or ownership-changed snapshots immediately", () => {
    const result = issued({ expiresAt: now + 1_000 });
    const principal = store.verify(result.deviceToken)!;
    now += 1_000;
    expect(store.revalidate(principal)).toBeNull();
    const another = issued();
    const active = store.verify(another.deviceToken)!;
    store.revoke(1, another.deviceId);
    expect(store.revalidate(active)).toBeNull();
    const moved = issued();
    const owned = store.verify(moved.deviceToken)!;
    getIdentitiesSqlite().prepare("UPDATE identities SET actor_id=2 WHERE id=1").run();
    expect(store.revalidate(owned)).toBeNull();
  });

  it("rejects stale grant snapshots, invalid metadata and changed actor selections", () => {
    const result = issued();
    const principal = store.verify(result.deviceToken)!;
    expect(store.revalidate({ ...principal, actorId: 2 })).toBeNull();
    expect(store.revalidate({ ...principal, identityIds: [3] })).toBeNull();
    const db = getIdentitiesSqlite();
    db.prepare("UPDATE device_credentials SET scopes=? WHERE id=?").run(JSON.stringify(["sessions:read", "sessions:turn"]), result.deviceId);
    expect(store.revalidate(principal)).toBeNull();
    const expanded = store.verify(result.deviceToken)!;
    db.prepare("UPDATE device_credentials SET scopes=? WHERE id=?").run(JSON.stringify(["sessions:read"]), result.deviceId);
    expect(store.revalidate(expanded)).toBeNull();
    db.prepare("UPDATE device_credentials SET identity_ids='[1,3]' WHERE id=?").run(result.deviceId);
    expect(store.revalidate(principal)).toBeNull();
    db.prepare("UPDATE device_credentials SET scopes='[\"admin\"]' WHERE id=?").run(result.deviceId);
    expect(store.revalidate(principal)).toBeNull();
  });

  it("rejects corrupt credential time metadata during both authentication and revalidation", () => {
    const result = issued();
    const principal = store.verify(result.deviceToken)!;
    const db = getIdentitiesSqlite();
    db.prepare("UPDATE device_credentials SET expires_at='invalid-time' WHERE id=?").run(result.deviceId);
    expect(store.verify(result.deviceToken)).toBeNull();
    expect(store.revalidate(principal)).toBeNull();
    db.prepare("UPDATE device_credentials SET expires_at=NULL, created_at=-1 WHERE id=?").run(result.deviceId);
    expect(store.verify(result.deviceToken)).toBeNull();
    expect(store.revalidate(principal)).toBeNull();
  });

  it("rejects revoked tokens immediately and invalid stored metadata", () => {
    const result = issued();
    expect(store.verify(result.deviceToken)).not.toBeNull();
    expect(store.revoke(1, result.deviceId)).toBe(true);
    expect(store.verify(result.deviceToken)).toBeNull();
    const another = issued();
    getIdentitiesSqlite().prepare("UPDATE device_credentials SET scopes = '[\"admin\"]' WHERE id = ?").run(another.deviceId);
    expect(store.verify(another.deviceToken)).toBeNull();
  });

  it("invalidates credentials whose identity is no longer owned", () => {
    const result = issued();
    getIdentitiesSqlite().prepare("UPDATE identities SET actor_id = 2 WHERE id = 1").run();
    expect(store.verify(result.deviceToken)).toBeNull();
  });

  it("keeps safe device listings without depending on the ephemeral request", () => {
    const result = issued();
    getIdentitiesSqlite().prepare("DELETE FROM pairing_requests").run();
    expect(store.list(1)[0]).toMatchObject({ id: result.deviceId, name: "Test phone", tokenPrefix: result.deviceToken.slice(0, 17) });
    expect(JSON.stringify(store.list(1))).not.toContain(result.deviceToken);
    expect(store.list(2)).toEqual([]);
  });

  it("serializes claims from independent processes with exactly one issuance", async () => {
    const pending = request();
    store.authorize(pending.pairingCode, 1, { scopes: ["sessions:read"], identityIds: [1] });
    const script = `
      import { getIdentitiesSqlite, closeIdentitiesDb } from ${JSON.stringify(new URL("./identities-db.ts", import.meta.url).href)};
      import { DeviceStore } from ${JSON.stringify(new URL("./devices.ts", import.meta.url).href)};
      let raw = ''; for await (const chunk of process.stdin) raw += chunk;
      const input = JSON.parse(raw);
      const result = new DeviceStore(getIdentitiesSqlite(), () => input.now).claim(input.pollToken);
      process.stdout.write(JSON.stringify({status:result.status}));
      closeIdentitiesDb();
    `;
    const claim = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        env: { PATH: process.env.PATH, TMPDIR: tmpdir(), BARRY_HOME: dir, BARRY_IDENTITIES_DB: join(dir, "identities.db"), NODE_ENV: "test", VITEST: "true" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.on("close", exit => {
        clearTimeout(timer);
        if (exit !== 0) { reject(new Error(`Fixture claim child failed: ${stderr}`)); return; }
        try { resolve(JSON.parse(stdout).status); } catch { reject(new Error("Invalid fixture claim response")); }
      });
      child.stdin.end(JSON.stringify({ now, pollToken: pending.pollToken }));
    });
    const outcomes = await Promise.all([claim(), claim(), claim(), claim()]);
    expect(outcomes.filter(status => status === "authorized")).toHaveLength(1);
    expect(outcomes.filter(status => status === "consumed")).toHaveLength(3);
    expect(getIdentitiesSqlite().prepare("SELECT COUNT(*) AS count FROM device_credentials").get()).toEqual({ count: 1 });
  }, 15_000);
});
