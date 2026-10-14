import { Barry } from "@barry-rocks/sdk";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { codexHomeRecordPath, prepareCodexRuntime } from "./runtime.js";
import { codexClosureLookup, reapCodexHomes } from "./retention.js";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const now = Date.parse("2026-10-09T00:00:00Z");
const old = "2026-08-01T00:00:00Z";
function scratch() { const root = realpathSync(mkdtempSync(join(tmpdir(), "barry-codex-retention-"))); cleanup.push(root); vi.stubEnv("BARRY_HOME", root); return root; }
function home(id: string) {
  const runtime = prepareCodexRuntime({ barrySessionId: id }); cleanup.push(runtime.codexHome);
  writeFileSync(codexHomeRecordPath(basename(runtime.codexHome)), JSON.stringify({ sessionId: id, lastUsedAt: old }));
  return { alias: runtime.codexHome, durable: realpathSync(runtime.codexHome) };
}
it("prunes only owned, unpinned conversations closed beyond the retention window", async () => {
  const root = scratch();
  const ids = ["expired", "live", "recent", "pinned", "unknown"].map(name => `${root}-${name}`);
  const homes = ids.map(home);
  const report = await reapCodexHomes(async id => id === ids[4] ? null : {
    id, status: id === ids[1] ? "running" : "completed", pinned: id === ids[3], endedAt: id === ids[2] ? "2026-10-06T00:00:00Z" : old,
  }, now);
  expect(report.removed).toEqual([ids[0]]);
  expect(existsSync(homes[0].alias)).toBe(false);
  expect(existsSync(homes[0].durable)).toBe(false);
  for (const kept of homes.slice(1)) expect(existsSync(kept.durable)).toBe(true);
});
it("keeps all conversations when the session service cannot answer", async () => {
  const root = scratch(); const record = home(`${root}-unavailable`);
  expect((await reapCodexHomes(async () => { throw new Error("offline"); }, now)).removed).toEqual([]);
  expect(existsSync(record.durable)).toBe(true);
});
it("runs the packed job entry when launched through an installation symlink", () => {
  const root = scratch();
  const registry = join(root, "services.json");
  writeFileSync(registry, JSON.stringify({ version: 2, generated: "2026-10-09T00:00:00Z", resources: { "sessions.api": { bag: "sessions", name: "api", kind: "service", url: "http://127.0.0.1:1" } } }));
  const entry = join(root, "job.js");
  symlinkSync(fileURLToPath(new URL("../dist/retention.js", import.meta.url)), entry);
  const result = spawnSync(process.execPath, [entry], { env: { PATH: "/usr/bin:/bin", HOME: root, BARRY_HOME: root, BARRY_SERVICE_REGISTRY: registry, BARRY_SECRET: "dummy-local-test", TMPDIR: root }, encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ removed: [], kept: [] });
});
it("serializes a new runtime preparation with an in-flight closure probe", async () => {
  const root = scratch(); const id = `${root}-racing`; const record = home(id);
  let release: (() => void) | undefined;
  let observed: (() => void) | undefined;
  const entered = new Promise<void>(resolve => { observed = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const sweep = reapCodexHomes(async () => { observed?.(); await wait; return { id, status: "running", pinned: false, endedAt: null }; }, now);
  await entered;
  expect(() => prepareCodexRuntime({ barrySessionId: id })).toThrow();
  release?.(); await sweep;
  expect(prepareCodexRuntime({ barrySessionId: id }).codexHome).toBe(record.alias);
});

const wireIdentity = {
  id: 3, name: "bux", token: "identity-token", vaultEmail: null, isDefault: false, createdAt: "2026-09-24T00:00:00Z", lastUsedAt: null, displayName: null, bags: [], traits: [], bounds: [], bound: null,
  adapters: {}, envKeys: [],
};
const wireSession = {
  id: "s1", name: "Session", systemPrompt: null, summary: null, repoPath: null, identityId: 3,
  identitySource: null, status: "running", traits: [], bound: null, pinned: false, useWorktree: false,
  worktreeStatus: null, worktreePath: null, baseRepoPath: null, source: null, provider: "claude",
  model: null, createdAt: "2026-09-24T00:00:00Z", startedAt: null,
};
it("reads closure through the public HTTP SDK and retains unknown ownership", async () => {
  const fetch = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
    String(url).endsWith("/identities") ? { identities: [wireIdentity] } : { ...wireSession, status: "completed", identityId: 3, endedAt: old },
  ), { headers: { "content-type": "application/json" } }));
  const lookup = codexClosureLookup(Barry.at({ baseUrl: "http://fixture.invalid", secret: "test-only", fetch, identities: { baseUrl: "http://fixture.invalid", secret: "test-only", fetch } }));
  expect(await lookup("s1")).toMatchObject({ id: "s1", status: "completed", endedAt: old });
  expect(String(fetch.mock.calls[1][0])).toBe("http://fixture.invalid/api/v1/sessions/s1");
  const unknownFetch = async (url: string | URL | Request) => new Response(JSON.stringify(
    String(url).endsWith("/identities") ? { identities: [wireIdentity] } : { ...wireSession, identityId: 999 },
  ), { headers: { "content-type": "application/json" } });
  const unknown = codexClosureLookup(Barry.at({ baseUrl: "http://fixture.invalid", secret: "test-only", fetch: unknownFetch,
    identities: { baseUrl: "http://fixture.invalid", secret: "test-only", fetch: unknownFetch },
  }));
  expect(await unknown("s1")).toBeNull();
});
