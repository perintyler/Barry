import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { installedPiRuntimeRegistration, workflowRuntimeRegistration } from "../../test/fixtures/workflow-runtime-registration.js";
import { installedIdentityWork } from "../../../bags/sessions/api/src/testing/installed-identity-work.js";

type Fixture = Awaited<ReturnType<typeof workflowRuntimeRegistration>>;
async function using(run: (fixture: Fixture) => Promise<void>) {
  const names = ["BARRY_SECRET", "REGISTRATION_FIXTURE_KEY", "NODE_OPTIONS"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.BARRY_SECRET = "harmless-parent-installation-canary";
  process.env.REGISTRATION_FIXTURE_KEY = "harmless-parent-provider-canary";
  process.env.NODE_OPTIONS = "--no-warnings";
  try {
    const fixture = await workflowRuntimeRegistration(), failures: unknown[] = [];
    try { await run(fixture); } catch (error) { failures.push(error); }
    try { await fixture.close(failures.length > 0); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Registration fixture failed; retained " + fixture.root);
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name];else process.env[name] = previous[name]; }
  }
}

const darwinIt = it.skipIf(process.platform !== "darwin");

darwinIt("registers actual retained native generations, distinguishes unchanged-version bytes and restores old identity after installation deletion", async () => {
  await using(async f => {
    const first = await f.registry.register(f.selected.id, Date.now() + 30000), observed = f.readMarker();
    expect(observed.argv).toContain("--registration-probe");
    expect(observed.argv[0]).toContain(join(f.spool, first.generation, "runtime", "runtime", "node"));
    expect(observed.env.BARRY_SECRET).toBeUndefined();expect(observed.env.REGISTRATION_FIXTURE_KEY).toBeUndefined();
    expect(observed.env.NODE_OPTIONS).toBeUndefined();f.assertNoApplicationInput();
    expect(f.db.prepare("SELECT state,handle_json FROM workflow_runtime_generations").all()).toEqual([{ state: "qualified", handle_json: expect.any(String) }]);
    expect(existsSync(join(f.spool, first.generation))).toBe(false);
    f.replace({ generation: "B" });
    const second = await f.registry.register(f.selected.id, Date.now() + 30000);
    expect(second.runtime.digest).not.toBe(first.runtime.digest);expect(second.recordHash).toBe(first.recordHash);
    expect(f.adapters.installed()[0]).toEqual(f.selected);
    f.removeInstalled();f.reopen();
    expect(f.registry.get(first.generation)).toEqual(first);expect(f.registry.current(f.selected.id)).toEqual(second);
    f.assertNoApplicationInput();
  });
}, 180000);

darwinIt("registers actual Pi before managed Sessions API readiness and retains generations through a real service restart", async () => {
  const f = await installedIdentityWork({ managedEntry: true, runtimeRegistration: true }), failures: unknown[] = [];
  try {
    const path = readdirSync(f.home, { recursive: true }).map(String).find(path => path.endsWith("workflow-runtimes/generations.db"));
    expect(path).toBeDefined();
    const rows = () => {
      const db = new Database(join(f.home, path!), { readonly: true });
      try { return db.prepare("SELECT generation,state,handle_json FROM workflow_runtime_generations ORDER BY rowid").all() as { generation: string; state: string; handle_json: string }[]; }
      finally { db.close(); }
    };
    expect(rows()).toEqual([{ generation: expect.any(String), state: "qualified", handle_json: expect.any(String) }]);
    const first = rows()[0].generation;await f.restartApi();
    expect(rows()).toHaveLength(2);expect(rows()[0].generation).toBe(first);expect(rows().every(row => row.state === "qualified")).toBe(true);
    for (const row of rows()) {
      const handle = JSON.parse(row.handle_json) as { pgid: number };
      let absent = false;try { process.kill(-handle.pgid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") absent = true;else throw error; }
      expect(absent).toBe(true);
    }
    expect(f.relayState.submissions).toBe(0);expect(f.ownerRows()).toHaveLength(0);expect(f.effectFiles()).toEqual([]);
    expect(f.diagnostics().filter(row => row.stdout.includes("sessions.workflow_runtime_registered"))).toHaveLength(2);
  } catch (error) { failures.push(error); }
  try { await f.close(failures.length > 0); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Managed registration failed; preserved " + f.root);
}, 180000);

darwinIt("registers the actual installed compiled Pi graph through the production startup helper without opening a session", async () => {
  const f = await installedPiRuntimeRegistration(), failures: unknown[] = [];
  try {
    const resource = await f.start();
    expect(resource.registrations).toHaveLength(1);
    const accepted = resource.registrations[0];expect(accepted.harness).toBe("pi");
    expect(resource.registry.current("pi")).toEqual(accepted);
    expect(f.rows()).toEqual([{ generation: accepted.generation, harness: "pi", runtime_json: expect.any(String), state: "qualified", handle_json: expect.any(String) }]);
    resource.close();
    expect(f.rows()[0].generation).toBe(accepted.generation);
  } catch (error) { failures.push(error); }
  try { await f.close(failures.length > 0); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Actual installed Pi registration failed; preserved " + f.root);
}, 180000);

darwinIt.each(["changed-declaration", "malformed-open"] as const)("refuses actual retained %s despite a cached original install object, before config or input", async kind => {
  await using(async f => {
    f.replace(kind === "changed-declaration" ? { label: "Changed after original import" } : { malformedOpen: true });
    await expect(f.registry.register(f.selected.id, Date.now() + 30000)).rejects.toThrow();
    expect(f.registry.current(f.selected.id)).toBeUndefined();f.assertNoApplicationInput();
    const rows = f.db.prepare("SELECT state,handle_json,probe_directory FROM workflow_runtime_generations").all() as { state: string; handle_json: string; probe_directory: string }[];
    expect(rows).toHaveLength(1);expect(rows[0].state).toBe("refused");expect(JSON.parse(rows[0].handle_json).pgid).toBeGreaterThan(0);
    expect(existsSync(rows[0].probe_directory)).toBe(true);expect(f.readMarker().env.BARRY_SECRET).toBeUndefined();
  });
}, 180000);
