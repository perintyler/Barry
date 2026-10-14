import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getIdentitiesSqlite, closeIdentitiesDb } from "./store/identities-db.js";
import type { DeviceStore } from "./store/devices.js";
import { installationOwner } from "./installation-owner.js";
let DeviceStoreClass: typeof import("./store/devices.js").DeviceStore;
import { PairingRequestSchema, PairingClaimSchema, DeviceListResponseSchema, DeviceVerifyResponseSchema } from "@barry-rocks/sdk/internal/auth";

const installationSecret = "barry_device_routes_fixture";
let createDeviceRouter: typeof import("./device-routes.js").createDeviceRouter;
let deviceErrors: typeof import("./device-routes.js").deviceErrors;
let server: Server;
let baseUrl: string;
let directory: string;
let previousDb: string | undefined;
let store: DeviceStore;
let now: number;
let operatorId: number | null;
let ownerReads: number;

beforeAll(async () => {
  vi.resetModules();
  vi.stubEnv("BARRY_SECRET", installationSecret);
  ({ createDeviceRouter, deviceErrors } = await import("./device-routes.js"));
  ({ DeviceStore: DeviceStoreClass } = await import("./store/devices.js"));
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(async () => {
  closeIdentitiesDb();
  directory = mkdtempSync(join(tmpdir(), "barry-device-routes-"));
  previousDb = process.env.BARRY_IDENTITIES_DB;
  process.env.BARRY_IDENTITIES_DB = join(directory, "identities.db");
  const db = getIdentitiesSqlite();
  db.prepare("INSERT INTO actors (id, token, type, name) VALUES (1, 'owner-one', 'user', 'one'), (2, 'owner-two', 'user', 'two')").run();
  db.prepare("INSERT INTO identities (id, token, actor_id, name) VALUES (1, 'identity-one', 1, 'one'), (2, 'identity-two', 2, 'two'), (3, 'identity-three', 1, 'three')").run();
  now = 1_000_000;
  operatorId = 1;
  ownerReads = 0;
  store = new DeviceStoreClass(db, () => now);
  const app = express();
  app.use(express.json());
  app.use("/default/devices", createDeviceRouter({ store }));
  app.use("/api/v1/devices", createDeviceRouter({ store, resolveOperator: async () => { ownerReads++; return operatorId; } }));
  app.use("/api/v1/devices", deviceErrors);
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  baseUrl = `http://127.0.0.1:${address.port}/api/v1/devices`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeIdentitiesDb();
  (await import("./store/identities-db.js")).closeIdentitiesDb();
  if (previousDb === undefined) delete process.env.BARRY_IDENTITIES_DB; else process.env.BARRY_IDENTITIES_DB = previousDb;
  rmSync(directory, { recursive: true, force: true });
});
async function send(path: string, body?: unknown, credential?: string, method = body === undefined ? "GET" : "POST") {
  return fetch(baseUrl + path, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const requestInput = () => ({ clientName: "Fixture phone", requestedScopes: ["sessions:read", "sessions:turn"], requestedIdentityIds: [1, 3] });
async function pair() {
  const response = await send("/pair/request", requestInput());
  expect(response.status).toBe(201);
  return PairingRequestSchema.parse(await response.json());
}
async function issue() {
  const pending = await pair();
  expect((await send("/pair/authorize", { code: pending.pairingCode, grant: { scopes: ["sessions:read"], identityIds: [1] } }, installationSecret)).status).toBe(200);
  const claim = PairingClaimSchema.parse(await (await send("/pair/claim", { pollToken: pending.pollToken })).json());
  if (claim.status !== "authorized") throw new Error("Expected fixture issuance");
  return { pending, claim };
}

describe("device owner HTTP API", () => {
  it("pairs publicly, approves as the authenticated owner and returns a reduced grant exactly once", async () => {
    const { pending, claim } = await issue();
    expect(claim.scopes).toEqual(["sessions:read"]);
    expect(claim.identityIds).toEqual([1]);
    const consumed = await send("/pair/claim", { pollToken: pending.pollToken });
    expect(consumed.status).toBe(410);
    expect(await consumed.json()).toEqual({ status: "consumed" });
    const listed = DeviceListResponseSchema.parse(await (await send("", undefined, installationSecret)).json());
    expect(listed.devices).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(claim.deviceToken);
    const verified = await send("/verify", { token: claim.deviceToken }, installationSecret);
    expect(verified.status).toBe(200);
    expect(DeviceVerifyResponseSchema.parse(await verified.json()).principal).toMatchObject({ kind: "device", actorId: 1, identityIds: [1] });
    expect(verified.headers.get("cache-control")).toBe("no-store");
  });

  it("requires installation credentials on every management and verification route, even on loopback", async () => {
    const { pending, claim } = await issue();
    ownerReads = 0;
    for (const credential of [undefined, pending.pollToken, claim.deviceToken, "wrong-secret"]) {
      for (const [path, body, method] of [
        ["", undefined, "GET"], ["/pair/pending", undefined, "GET"],
        ["/pair/authorize", { code: pending.pairingCode, grant: null }, "POST"],
        ["/verify", { token: claim.deviceToken }, "POST"], [`/${claim.deviceId}`, undefined, "DELETE"],
      ] as const) expect((await send(path, body, credential, method)).status).toBe(401);
    }
    expect(ownerReads).toBe(0);
    expect(store.verify(claim.deviceToken)).not.toBeNull();
  });

  it("does not accept client-selected actors or expand identity/scope approval", async () => {
    const pending = await pair();
    const approval = { code: pending.pairingCode, grant: { scopes: ["sessions:read"], identityIds: [1] } };
    expect((await send("/pair/authorize", { ...approval, actorId: 2 }, installationSecret)).status).toBe(400);
    expect((await send("/pair/authorize", { ...approval, grant: { scopes: ["tools:invoke"], identityIds: [1] } }, installationSecret)).status).toBe(403);
    expect((await send("/pair/authorize", { ...approval, grant: { scopes: ["sessions:read"], identityIds: [2] } }, installationSecret)).status).toBe(403);
    operatorId = 2;
    expect((await send("/pair/authorize", approval, installationSecret)).status).toBe(403);
    expect(store.pending()).toHaveLength(1);
  });

  it("refuses unresolved installation ownership instead of choosing an actor", async () => {
    operatorId = null;
    const response = await send("", undefined, installationSecret);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ detail: "installation_owner_unresolved" });
  });

  it("uses the explicit owner binding and refuses unbound ownership", async () => {
    const url = baseUrl.replace("/api/v1/devices", "/default/devices");
    const options = { headers: { Authorization: `Bearer ${installationSecret}` } };
    expect((await fetch(url, options)).status).toBe(503);
    installationOwner().bind({ actorId: 1, actorToken: "owner-one" });
    expect((await fetch(url, options)).status).toBe(200);
    expect(() => getIdentitiesSqlite().prepare("DELETE FROM actors WHERE id = 1").run()).toThrow("FOREIGN KEY");
    getIdentitiesSqlite().prepare("DELETE FROM installation_owner").run();
    getIdentitiesSqlite().prepare("DELETE FROM actors WHERE id = 1").run();
    expect((await fetch(url, options)).status).toBe(503);
    expect(getIdentitiesSqlite().prepare("SELECT COUNT(*) AS count FROM actors").get()).toEqual({ count: 1 });
  });

  it("records a rejection and never turns it into token issuance", async () => {
    const pending = await pair();
    expect(await (await send("/pair/authorize", { code: pending.pairingCode, grant: null }, installationSecret)).json()).toMatchObject({ status: "rejected" });
    const rejected = await send("/pair/claim", { pollToken: pending.pollToken });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ status: "rejected" });
    expect((await send("/pair/authorize", { code: pending.pairingCode, grant: { scopes: ["sessions:read"], identityIds: [1] } }, installationSecret)).status).toBe(410);
    expect(store.list(1)).toEqual([]);
  });

  it("enforces expiry and polling/source limits with retry headers", async () => {
    const pending = await pair();
    expect((await send("/pair/claim", { pollToken: pending.pollToken })).status).toBe(202);
    const throttled = await send("/pair/claim", { pollToken: pending.pollToken });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("2");
    for (let index = 0; index < 4; index++) await pair();
    const allocation = await send("/pair/request", requestInput());
    expect(allocation.status).toBe(429);
    expect(allocation.headers.get("retry-after")).toBe("60");
    now += 300_000;
    const expired = await send("/pair/claim", { pollToken: pending.pollToken });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ status: "expired" });
  });

  it("rejects malformed/extra fields and non-JSON mutation requests", async () => {
    for (const body of [{ ...requestInput(), requestedScopes: ["admin"] }, { ...requestInput(), actorId: 1 }, { ...requestInput(), requestedIdentityIds: [1, 1] }]) {
      expect((await send("/pair/request", body)).status).toBe(400);
    }
    expect((await send("/pair/claim", { pollToken: "bad" })).status).toBe(400);
    expect((await send("/pair/claim", { code: "123-456" })).status).toBe(400);
    const form = await fetch(baseUrl + "/pair/request", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(requestInput()) });
    expect(form.status).toBe(415);
    expect(store.pending()).toEqual([]);
  });

  it("revokes immediately, preserves actor ownership and does not leak credentials in errors", async () => {
    const { claim } = await issue();
    operatorId = 2;
    expect((await send(`/${claim.deviceId}`, undefined, installationSecret, "DELETE")).status).toBe(404);
    operatorId = 1;
    expect((await send(`/${claim.deviceId}`, undefined, installationSecret, "DELETE")).status).toBe(200);
    expect((await send(`/${claim.deviceId}`, undefined, installationSecret, "DELETE")).status).toBe(200);
    const response = await send("/verify", { token: claim.deviceToken }, installationSecret);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(claim.deviceToken);
    expect(store.verify(claim.deviceToken)).toBeNull();
  });

  it("bounds invalid public polling and strips query secrets from problem instances", async () => {
    for (let index = 0; index < 120; index++) expect((await send("/pair/claim", { pollToken: "bad" })).status).toBe(400);
    const response = await send("/pair/claim?secret=fixture-query-secret", { pollToken: "bad" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(await response.text()).not.toContain("fixture-query-secret");
  });

  it("redacts malformed JSON caught before the router", async () => {
    const response = await fetch(baseUrl + "/pair/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"pollToken": "fixture-raw-secret" trailing' });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("fixture-raw-secret");
  });

  it("uses the public SDK for pairing, approval, listing and revocation", async () => {
    const { BarryClient } = await import("@barry-rocks/sdk/internal/client");
    const origin = baseUrl.replace("/api/v1/devices", "");
    const phone = new BarryClient({ baseUrl: origin + "/sessions", secret: "unrelated-session-credential", identities: { baseUrl: origin } });
    const owner = new BarryClient({ baseUrl: origin + "/sessions", identities: { baseUrl: origin, secret: installationSecret } });
    const pending = await phone.devices.requestPairing({ ...requestInput(), requestedScopes: ["sessions:read", "sessions:turn"] });
    expect((await owner.devices.pending())[0]).toMatchObject({ pairingCode: pending.pairingCode });
    await expect(phone.devices.list()).rejects.toMatchObject({ status: 401 });
    await owner.devices.authorize(pending.pairingCode, { scopes: ["sessions:read"], identityIds: [1] });
    const claim = await phone.devices.claimPairing(pending.pollToken);
    if (claim.status !== "authorized") throw new Error("Expected SDK fixture issuance");
    expect((await owner.devices.list())[0]).toMatchObject({ id: claim.deviceId, identityIds: [1] });
    await owner.devices.revoke(claim.deviceId);
    expect(store.verify(claim.deviceToken)).toBeNull();
    expect(await phone.devices.claimPairing(pending.pollToken)).toEqual({ status: "consumed" });
  });

  it("runs the real system CLI with selected installation credentials and no sessions service", async () => {
    now = Date.now();
    const pending = await pair();
    const home = join(directory, "operator-home");
    mkdirSync(join(home, "app-support"), { recursive: true });
    writeFileSync(join(home, "app-support", "env"), `BARRY_SECRET=${installationSecret}\n`, { mode: 0o600 });
    writeFileSync(join(home, "app-support", "bag-resources.json"), JSON.stringify({ version: 2, generated: new Date().toISOString(), resources: {
      "identities.identities": { bag: "identities", name: "identities", kind: "service", url: baseUrl.replace("/api/v1/devices", "") },
    } }));
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    async function command(args: string[], group = "device") {
      const child = spawn(process.execPath, ["--import", "tsx", join(root, "cli/src/index.ts"), group, ...args], {

        cwd: root, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, BARRY_HOME: home,
          BARRY_CONFIG_DB: join(home, "config.db"), BARRY_IDENTITIES_DB: process.env.BARRY_IDENTITIES_DB,
          BARRY_EVENTS_DB: ":memory:", BARRY_SESSIONS_DB: join(home, "sessions.db"), BARRY_BUILTIN_DIR: join(root, "bags"),
          BARRY_SECRET: "unrelated-shell-fixture", NODE_ENV: "test", VITEST: "true", LOG_LEVEL: "silent", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 40_000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        return { code, stdout, stderr };
      } finally { clearTimeout(deadline); }
    }
    const approval = await command(["pair", pending.pairingCode, "--yes", "--scopes", "sessions:read", "--identities", "1"]);
    expect(approval.stderr).not.toContain(installationSecret);
    expect(approval.code, approval.stderr).toBe(0);
    expect(approval.stdout).toContain('Authorized "Fixture phone"');
    const claim = PairingClaimSchema.parse(await (await send("/pair/claim", { pollToken: pending.pollToken })).json());
    if (claim.status !== "authorized") throw new Error("Expected CLI fixture issuance");
    expect(claim.identityIds).toEqual([1]);
    const listed = await command(["list", "--json"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).devices).toEqual([expect.objectContaining({ id: claim.deviceId, unusedExpiresAt: now + 600_000 })]);
    expect(listed.stdout).not.toContain(claim.deviceToken);
    const revoked = await command(["revoke", claim.deviceId, "--yes"]);
    expect(revoked.code, revoked.stderr).toBe(0);
    expect(store.verify(claim.deviceToken)).toBeNull();
    const bound = await command(["2", "--yes", "--json"], "owner");
    expect(bound.code, bound.stderr).toBe(0);
    expect(JSON.parse(bound.stdout)).toMatchObject({ owner: { actorId: 2, name: "two" } });
    expect(bound.stdout).not.toContain("owner-two");
    expect(installationOwner().current()?.actorId).toBe(2);
    const managed = await fetch(baseUrl.replace("/api/v1/devices", "/default/devices"), { headers: { Authorization: `Bearer ${installationSecret}` } });
    expect(managed.status).toBe(200);
    expect(await managed.json()).toEqual({ devices: [] });
  }, 120_000);
});
