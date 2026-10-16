import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Barry, requestCaller, type Caller, type JobRun } from "@barry-rocks/sdk";
import { BarryApiError, BarryClient } from "@barry-rocks/sdk/internal/client";
import { findBags, clearBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";

import type { BagRegistry } from "@barry-rocks/sdk/bags";
import { bags } from "./bags.js";
import { identities } from "./identities.js";

vi.mock("@barry-rocks/sdk/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/services")>(),
  instanceEnvValue: vi.fn(() => "test-secret"),
  getServiceUrl: vi.fn(() => "http://example.test"),
}));

import { instanceEnvValue, getServiceUrl } from "@barry-rocks/sdk/services";


const scratch = mkdtempSync(join(tmpdir(), "bags-subject-"));
const local = join(scratch, "local");
mkdirSync(local);
writeFileSync(join(local, "bag.yaml"), "name: local\ndescription: Fixture bag\n");
const owner: Caller = { kind: "owner" };
const session: Caller = { kind: "session", identity: "reviewer", sessionId: "s1" };
const device = requestCaller({ kind: "device", credentialId: "d1", actorId: 1, identityIds: [], scopes: [] });
const fixture: BagRegistry = {
  local: { type: "local", path: local },
  sessions: { type: "remote", url: "http://sessions.test", tools: [
    { toolName: "get_messages", namespace: "sessions", access: "read", description: "Read messages" },
    { toolName: "send", namespace: "sessions", access: "readwrite" },
    { toolName: "stop", namespace: "sessions", access: "readwrite" },
  ] },
  "sessions/zebra": { type: "remote", command: "zebra" },
  "sessions/search": { type: "remote" },
  "other/search": { type: "remote" },
};
function snapshot(registry: BagRegistry) {
  writeFileSync(join(scratch, "bags.json"), JSON.stringify({ bags: registry }));
  clearBagRegistrySnapshot();
}
beforeEach(() => {
  vi.stubEnv("BARRY_BAGS_SNAPSHOT", join(scratch, "bags.json"));
  snapshot(fixture);
  Barry.use(identities, bags);
});
afterEach(() => { Barry.reset(); clearBagRegistrySnapshot(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it("lists the registry with the available-bags route's descriptions", async () => {
  expect(await Barry.bags()).toEqual([
    { name: "local", type: "local", description: `Local — ${local}` },
    { name: "sessions", type: "remote", description: "http://sessions.test" },
    { name: "sessions/zebra", type: "remote", description: "zebra" },
    { name: "sessions/search", type: "remote", description: "Remote" },
    { name: "other/search", type: "remote", description: "Remote" },
  ]);
  expect(await bags.list(session)).toHaveLength(5);
});
it("maps loaded tool summaries and readwrite access", async () => {
  expect(await Barry.as(session).bag("sessions").tools()).toEqual([
    { name: "get_messages", namespace: "sessions", access: "read", bag: "sessions" },
    { name: "send", namespace: "sessions", access: "write", bag: "sessions" },
    { name: "stop", namespace: "sessions", access: "write", bag: "sessions" },
  ]);
  expect(await bags.tools("local", owner)).toEqual([]);
});
it("refuses unknown bags", async () => {
  await expect(bags.tools("missing", owner)).rejects.toMatchObject({ reason: "not_found" });
});
it("finds the shipped session-vector-search bag from a registry of absolute paths", async () => {
  const dir = fileURLToPath(new URL("../../..", import.meta.url));
  const local = findBags(dir);
  snapshot(Object.fromEntries(Object.entries(local).map(([name, path]) => [name, { type: "local", path: join(dir, path) }])));
  expect(local["session-vector-search"]).toBe("session-vector-search");
});
it("refuses every method for a device before reading or reaching the API", async () => {
  vi.stubEnv("BARRY_BAGS_SNAPSHOT", join(scratch, "absent.json"));
  const connect = vi.spyOn(BarryClient, "connect");
  for (const call of [() => bags.list(device), () => bags.tools("sessions", device),
    () => bags.runJob("sessions", "work", {}, {}, device)]) {
    await expect(call()).rejects.toMatchObject({ reason: "forbidden" });
  }
  expect(connect).not.toHaveBeenCalled();
});

const state: JobRun = {
  id: "sch_1", job: "ops:work", status: "pending", reason: null, key: "k1", callerSessionId: null,
  attempts: 0, runId: null, output: null, outputType: null,
  createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
};
function client() {
  const run = vi.fn(async () => ({ state }));
  const connect = vi.spyOn(BarryClient, "connect").mockReturnValue({ jobs: { run } } as never);
  return { run, connect };
}
describe("runJob", () => {
  it("returns the durable run, forwarding the key and session caller", async () => {
    const { run, connect } = client();
    expect(await bags.runJob("ops", "work", { x: 1 }, { key: "k1" }, session)).toEqual(state);
    expect(connect).toHaveBeenCalledWith({ baseUrl: "http://example.test", secret: "test-secret" });
    expect(run).toHaveBeenCalledWith("ops:work", { x: 1 }, { key: "k1", callerSessionId: "s1" });
    await Barry.bag("ops").job("work").run({});
    expect(run).toHaveBeenLastCalledWith("ops:work", {}, {});
  });
  it("refuses choosing an identity before making an HTTP request", async () => {
    const { connect } = client();
    await expect(bags.runJob("ops", "work", {}, { identity: "other" }, owner)).rejects.toMatchObject({ reason: "unavailable" });
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([[403, "forbidden"], [404, "not_found"], [409, "conflict"], [422, "invalid"], [503, "unavailable"]])("translates API status %s to %s", async (status, reason) => {
      const { run } = client();
      run.mockRejectedValueOnce(new BarryApiError("Refused", { status: Number(status), code: "refused" }));
      await expect(bags.runJob("ops", "work", {}, {}, owner)).rejects.toMatchObject({ reason, message: "Refused" });
    });
  it("reports a missing secret without connecting", async () => {
    const { connect } = client();
    vi.mocked(instanceEnvValue).mockReturnValueOnce(undefined);
    await expect(bags.runJob("ops", "work", {}, {}, owner)).rejects.toMatchObject({ reason: "unavailable", message: expect.stringContaining("BARRY_SECRET") });
    expect(connect).not.toHaveBeenCalled();
  });
  it("reports an unregistered sessions API", async () => {
    const { connect } = client();
    vi.mocked(getServiceUrl).mockImplementationOnce(() => { throw new Error("Missing service"); });
    await expect(bags.runJob("ops", "work", {}, {}, owner)).rejects.toMatchObject({ reason: "unavailable", message: expect.stringContaining("not registered") });
    expect(connect).not.toHaveBeenCalled();
  });
});
