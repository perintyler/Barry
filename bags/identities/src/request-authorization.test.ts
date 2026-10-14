import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAuth } from "@barry-rocks/sdk/services/http";
import { identityRequestAuthorization } from "./request-authorization.js";
import { devices, installationOperator } from "./devices.js";
import { installationOwner } from "./installation-owner.js";
import { createIdentitiesRouter } from "./identities.js";
import { identities } from "./operations/identities.js";
import { Barry } from "@barry-rocks/sdk";
import { closeIdentitiesDb, getIdentitiesSqlite } from "./store/identities-db.js";

let directory: string;
let previousDb: string | undefined;
let server: Server;
let baseUrl: string;
beforeEach(async () => {
  closeIdentitiesDb();
  directory = mkdtempSync(join(tmpdir(), "barry-device-authorization-"));
  previousDb = process.env.BARRY_IDENTITIES_DB;
  process.env.BARRY_IDENTITIES_DB = join(directory, "identities.db");
  const db = getIdentitiesSqlite();
  db.prepare("INSERT INTO actors (id, token, type, name) VALUES (1, 'owner-one', 'user', 'one'), (2, 'owner-two', 'user', 'two')").run();
  db.prepare("INSERT INTO identities (id, token, actor_id, name) VALUES (1, 'identity-one', 1, 'one'), (2, 'identity-two', 2, 'two'), (3, 'identity-three', 1, 'three')").run();
  const app = express();
  app.use(express.json());
  const authorization = identityRequestAuthorization();
  applyAuth(app, { ...authorization, verifyCredential: async credential => {
    if (credential !== "fixture-operator") return authorization.verifyCredential(credential, new AbortController().signal);
    const actorId = await installationOperator();
    if (actorId === null) return null;
    return { kind: "installation", actorId, credentialId: "installation" };
  } });
  Barry.use(identities);
  app.use("/api/v1/identities", createIdentitiesRouter());
  app.use((_request, response) => response.sendStatus(404));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  Barry.reset();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeIdentitiesDb();
  if (previousDb === undefined) delete process.env.BARRY_IDENTITIES_DB; else process.env.BARRY_IDENTITIES_DB = previousDb;
  rmSync(directory, { recursive: true, force: true });
});
function pair(identityId = 1, actorId = 1, scope: "identities:read" | "sessions:read" = "identities:read") {
  const store = devices();
  const pending = store.request({ clientName: "Phone", requestedScopes: [scope], requestedIdentityIds: [identityId] }, `source-${identityId}-${scope}`);
  store.authorize(pending.pairingCode, actorId, { scopes: [scope], identityIds: [identityId] });
  const claim = store.claim(pending.pollToken);
  if (claim.status !== "authorized") throw new Error("Fixture pairing failed");
  return claim;
}
function request(token: string, path: string, method = "GET") {
  return fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}` } });
}
describe("identity device authorization", () => {
  it("uses the bound second user for operator reads and writes", async () => {
    installationOwner().bind({ actorId: 2, actorToken: "owner-two" });
    const response = await request("fixture-operator", "/api/v1/identities/2");
    expect(response.status).toBe(200);
    expect((await response.json()).identity.name).toBe("two");
    const defaulted = await request("fixture-operator", "/api/v1/identities/2/set-default", "POST");
    expect(defaulted.status).toBe(200);
    const settings = getIdentitiesSqlite().prepare("SELECT settings FROM actors WHERE id=2").get() as { settings: string };
    expect(JSON.parse(settings.settings)).toMatchObject({ defaultBarry: "two" });
    // Another actor's identity is not the bound owner's to read.
    expect((await request("fixture-operator", "/api/v1/identities/1")).status).toBe(404);
  });
  it("uses the paired actor rather than the first installation user", async () => {
    const claim = pair(2, 2);
    const response = await request(claim.deviceToken, "/api/v1/identities/2");
    expect(response.status).toBe(200);
    expect((await response.json()).identity.name).toBe("two");
    expect((await request(claim.deviceToken, "/api/v1/identities/1")).status).toBe(403);
  });
  it("reads a granted identity by name and refuses another name", async () => {
    const claim = pair();
    const response = await request(claim.deviceToken, "/api/v1/identities/one");
    expect(response.status).toBe(200);
    expect((await response.json()).identity.name).toBe("one");
    for (const name of ["three", "two", "missing", "effective", "bags"]) {
      expect((await request(claim.deviceToken, `/api/v1/identities/${name}`)).status).toBe(403);
    }
  });
  it("refuses ungranted identities, mutations, lists, proxy operations and ambiguous paths", async () => {
    const claim = pair();
    for (const path of ["/api/v1/identities/3", "/api/v1/identities", "/api/v1/traits", "/api/v1/identities/1/effective", "/api/v1/identities/01", "/api/v1/identities/1suffix", "/api/v1/identities/%31"]) {
      expect((await request(claim.deviceToken, path)).status, path).toBe(403);
    }
    expect((await request(claim.deviceToken, "/api/v1/identities/1", "DELETE")).status).toBe(403);
    expect(getIdentitiesSqlite().prepare("SELECT id FROM identities WHERE id = 1").get()).toBeTruthy();
  });
  it("enforces finite scopes and immediate credential revocation", async () => {
    const wrongScope = pair(1, 1, "sessions:read");
    expect((await request(wrongScope.deviceToken, "/api/v1/identities/1")).status).toBe(403);
    const claim = pair();
    expect((await request(claim.deviceToken, "/api/v1/identities/1")).status).toBe(200);
    devices().revoke(1, claim.deviceId);
    expect((await request(claim.deviceToken, "/api/v1/identities/1")).status).toBe(401);
  });
  it("rechecks canonical ownership after pairing", async () => {
    const claim = pair();
    getIdentitiesSqlite().prepare("UPDATE identities SET actor_id = 2 WHERE id = 1").run();
    expect((await request(claim.deviceToken, "/api/v1/identities/1")).status).toBe(401);
  });
});
