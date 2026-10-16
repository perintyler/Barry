/**
 * The identities routes end to end: the SDK client, which validates every
 * response against the API's schemas, against the router over a scratch
 * store and scratch identity directories. What the operations decide is
 * tested beside them; this proves the HTTP door delivers it intact.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const scratch = mkdtempSync(join(tmpdir(), "identity-routes-"));
process.env.BARRY_HOME = join(scratch, "home");
process.env.BARRY_IDENTITIES_DB = join(scratch, "identities.db");
process.env.BARRY_CONFIG_DB = join(scratch, "config.db");
process.env.BARRY_BAGS_SNAPSHOT = join(scratch, "bags.snapshot.json");

// The API never spawns anything for an identity request; a spawn here would be the bug.
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: mockSpawn,
}));
vi.mock("./operations/effects.js", () => ({ announceIdentity: vi.fn(), refreshLiveSessions: vi.fn() }));

const { BarryClient } = await import("@barry-rocks/sdk/internal/client");
const { createIdentitiesRouter } = await import("./identities.js");
const { boundsRouter } = await import("./bounds.js");
const { identities } = await import("./operations/identities.js");
const { bags } = await import("./operations/bags.js");
const { Barry } = await import("@barry-rocks/sdk");
const { fakeSessions } = await import("@barry-rocks/sdk/testing");
const { installationOwner } = await import("./installation-owner.js");
const { Identities } = await import("./store/identities.js");
const { closeIdentitiesDb } = await import("./store/identities-db.js");
const { getIdentityDir } = await import("./paths.js");

let server: Server;
let baseUrl: string;
let actorId: number;
const removeAll = vi.fn(async () => 2);

beforeAll(async () => {
  writeFileSync(join(scratch, "bags.snapshot.json"), JSON.stringify({ bags: { fixture: { type: "local", path: join(scratch, "fixture") } } }));
  actorId = installationOwner().provision({ username: "owner" }).actorId;
  Barry.use(identities, bags, fakeSessions({ removeAll }));
  const app = express();
  app.use(express.json());
  app.use("/api/v1/identities", createIdentitiesRouter());
  app.use("/api/v1/bounds", boundsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  Barry.reset();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeIdentitiesDb();
  rmSync(scratch, { recursive: true, force: true });
});

const client = () => new BarryClient({ baseUrl, identities: { baseUrl } });
const yamlOf = (name: string) => parseYaml(readFileSync(join(getIdentityDir(name), "identity.yaml"), "utf8")) as Record<string, unknown>;
let counter = 0;

describe("the identities API through the SDK client", () => {
  it("creates a directory identity, and edits and clears its bounds in identity.yaml", async () => {
    const name = `api-${++counter}`;
    const created = await client().identities.create({ name, displayName: "Assistant", bounds: ["readonly"] });
    expect(created.identity).toMatchObject({ name, source: "file", displayName: "Assistant", bounds: ["readonly"] });
    expect(yamlOf(name)).toMatchObject({ displayName: "Assistant", bounds: ["readonly"] });

    const changed = await client().identities.update(created.identity.id, { displayName: "Updated", bounds: ["no-network"] });
    expect(changed.identity).toMatchObject({ displayName: "Updated", bounds: ["no-network"] });
    const cleared = await client().identities.update(created.identity.id, { bounds: null });
    expect(cleared.identity.bounds).toEqual([]);
    expect(yamlOf(name)).not.toHaveProperty("bound");
    expect(yamlOf(name)).not.toHaveProperty("scope");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("takes an identity created with source db as a directory too", async () => {
    const name = `api-${++counter}`;
    const created = await client().identities.create({ name, source: "db" });
    expect(created.identity.source).toBe("file");
    expect(yamlOf(name).name).toBe(name);
  });

  it("reads an identity by its row id, and answers null for one that does not exist", async () => {
    const name = `api-${++counter}`;
    const { identity } = await client().identities.create({ name });
    expect(await client().identities.get(identity.id)).toMatchObject({ id: identity.id, name, source: "file", envKeys: [] });
    expect(await client().identities.get(identity.id + 10_000)).toBeNull();
  });

  it("serves a row with no directory, with a high id, as a db identity", async () => {
    const row = await Identities.create({ actor_id: actorId, name: `row-${++counter}`, metadata: {} });
    expect(await client().identities.get(row.id)).toMatchObject({ id: row.id, source: "db" });
  });

  it.each([{ bound: { unknownRule: true } }, { unrecognized: true }, { scope: { deniedTools: ["bash"] } }])(
    "refuses invalid update input %j without writing",
    async (body) => {
      const name = `api-${++counter}`;
      const { identity } = await client().identities.create({ name });
      const before = readFileSync(join(getIdentityDir(name), "identity.yaml"), "utf8");
      const response = await fetch(`${baseUrl}/api/v1/identities/${identity.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect(readFileSync(join(getIdentityDir(name), "identity.yaml"), "utf8")).toBe(before);
    },
  );

  it("refuses unknown creation fields and retired traits before creating anything", async () => {
    const invalid = await fetch(`${baseUrl}/api/v1/identities`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "never", bound: { invalid: true } }) });
    expect(invalid.status).toBe(400);
    const retiredTraits = await fetch(`${baseUrl}/api/v1/identities`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "never", traits: ["no-such-trait"] }) });
    expect(retiredTraits.status).toBe(400);
    expect((await retiredTraits.json()).error).toBe("Invalid identity creation input");
    expect(await Identities.getByName(actorId, "never")).toBeUndefined();
  });

  it("answers a taken name with 409", async () => {
    const name = `api-${++counter}`;
    await client().identities.create({ name });
    const response = await fetch(`${baseUrl}/api/v1/identities`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    expect(response.status).toBe(409);
  });

  it("stores notifier, GitHub installation and native-tools switch, and clears GitHub with null", async () => {
    const name = `api-${++counter}`;
    const { identity } = await client().identities.create({ name });
    const patch = (body: unknown) => fetch(`${baseUrl}/api/v1/identities/${identity.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await patch({ statusNotify: { tool: "notify", target: "#ops" }, githubInstallationId: 42, adapters: { codex: { default: true, model: "gpt" } } })).status).toBe(200);
    expect(yamlOf(name)).toMatchObject({ status_notify: { tool: "notify", target: "#ops" }, github: { installationId: 42 }, adapters: { codex: { default: true, model: "gpt" } } });
    expect((await patch({ statusNotify: { target: "#ops" } })).status).toBe(400);
    expect((await patch({ defaultCodingAgent: "claude" })).status).toBe(400);
    expect((await patch({ githubInstallationId: null })).status).toBe(200);
    expect(yamlOf(name)).not.toHaveProperty("github");
  });

  it("refuses a rename over the API: the name lives in identity.yaml and names keychain accounts", async () => {
    const name = `api-${++counter}`;
    const { identity } = await client().identities.create({ name });
    const response = await fetch(`${baseUrl}/api/v1/identities/${identity.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "renamed" }) });
    expect(response.status).toBe(409);
    expect(yamlOf(name).name).toBe(name);
  });

  it("accepts the identity's own name beside a change, as a no-op", async () => {
    const name = `api-${++counter}`;
    await client().identities.create({ name });
    const response = await fetch(`${baseUrl}/api/v1/identities/${name}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, displayName: "Kept" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).identity).toMatchObject({ name, displayName: "Kept" });
  });

  it("refuses to delete a directory identity, and deletes a row with its sessions", async () => {
    const name = `api-${++counter}`;
    const { identity } = await client().identities.create({ name });
    const refused = await fetch(`${baseUrl}/api/v1/identities/${identity.id}`, { method: "DELETE" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).hint).toContain(`barry identity delete ${name}`);

    const row = await Identities.create({ actor_id: actorId, name: `row-${++counter}`, metadata: {} });
    const removed = await fetch(`${baseUrl}/api/v1/identities/${row.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(removeAll).toHaveBeenCalledWith(String(row.id), { kind: "owner" });
    expect(await Identities.get(row.id)).toBeUndefined();
  });
  it.each(["name", "id"] as const)("gets, updates, defaults and refuses directory deletion by %s", async (kind) => {
    const name = `named-${++counter}`;
    const { identity: row } = await client().identities.create({ name });
    const ref = kind === "name" ? name : row.id;
    expect(await client().identities.get(ref)).toMatchObject({ id: row.id, name });
    expect((await client().identities.update(ref, { displayName: "Changed" })).identity.displayName).toBe("Changed");
    await client().identities.setDefault(ref);
    await expect(client().identities.remove(ref)).rejects.toMatchObject({ status: 400 });
    const removable = await Identities.create({ actor_id: actorId, name: `row-${++counter}`, metadata: {} });
    const removableRef = kind === "name" ? removable.name : removable.id;
    await client().identities.remove(removableRef);
    expect(await client().identities.get(removableRef)).toBeNull();
  });

  it("passes a bag name through the auth routes", async () => {
    const response = await fetch(`${baseUrl}/api/v1/identities/bags/fixture/auth`, { method: "POST" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Bag "fixture" is local');
    const status = await fetch(`${baseUrl}/api/v1/identities/bags/fixture/auth/status`);
    expect(await status.json()).toEqual({ status: "not_started" });
  });

  it("answers 404 for an unknown name", async () => {
    const response = await fetch(`${baseUrl}/api/v1/identities/no-such-identity`);
    expect(response.status).toBe(404);
    expect(await client().identities.get("no-such-identity")).toBeNull();
  });

  it("decodes the identity, bound and available-bag lists through the SDK", async () => {
    expect(await client().identities.list()).toEqual(expect.any(Array));
    expect(await client().identities.bounds()).toEqual(expect.any(Array));
    expect(await client().identities.bags()).toEqual(expect.any(Array));
  });
});
