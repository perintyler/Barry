/** Actual installed registry/CAS/native registration; no model or turn fixture. */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { WorkArtifactStore } from "@barry-rocks/sdk/internal/workflows";
import { WorkflowRuntimeRegistry } from "../../../bags/sessions/api/src/workflow-runtime-registry.js";
import { registerInstalledWorkflowRuntimes } from "../../../bags/sessions/api/src/workflow-runtime-installation.js";

export async function workflowRuntimeRegistration() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-registration-native-")));
  const installed = join(root, "installed"), spool = join(root, "spool"), marker = join(root, "probe-import.json"), forbidden = join(root, "forbidden-input");
  mkdirSync(installed, { mode: 0o700 });mkdirSync(spool, { mode: 0o700 });
  const metadata = { name: "@fixture/registered-runtime", version: "1.0.0", type: "module", exports: { ".": { import: "./index.js" } }, barry: { sessionAdapter: { contractVersion: 1 } } };
  writeFileSync(join(installed, "package.json"), JSON.stringify(metadata));
  const manifest = "name: registration-fixture\ndescription: Credential declarations only; no resolved secrets\ncredentials:\n  REGISTRATION_FIXTURE_KEY: {source: vault, item: fixture-key, field: password}\n";
  writeFileSync(join(installed, "bag.yaml"), manifest);
  const data = {
    id: "registration-fixture", label: "Registration fixture", bag: ".", defaultMode: "hosted",
    requirements: { binary: { command: "fixture", versionArgs: ["--version"], versionPattern: "(\\d+\\.\\d+\\.\\d+)", install: { fallback: "fixture only" }, pin: { version: "1.0.0", enforcedBy: "fixture bundled bytes" } } },
    capabilities: { mcpTransports: [], toolDenial: "native", systemPromptFormat: "raw", skillsMount: "none", withoutKey: "unauthenticated", endpoint: "configurable" },
    tools: [],
    modes: { hosted: { approvalContinuation: "durable", structuredOutput: "prompted", native: { controllable: [] },
      guarantees: { capture: "total", delivery: "wake", steer: true, interrupt: true, gating: "per-call", keepsVendorUi: false, identity: "inherent" },
      verifiedOn: "1.0.0", evidence: { check: "fixture", proves: "registration only; callbacks must never run" }, egressSandbox: false }, guest: null, instrumented: null },
  };
  function source(options: { label?: string; malformedOpen?: boolean; generation?: string } = {}) {
    const record = { ...data, ...(options.label ? { label: options.label } : {}) };
    return `import{writeFileSync}from'node:fs';
if(process.env.BARRY_WORKFLOW_CLOSURE_SHA256)writeFileSync(${JSON.stringify(marker)},JSON.stringify({argv:process.argv,env:process.env,pid:process.pid}),{mode:0o600});
const adapter=${JSON.stringify(record)};
adapter.modes.hosted.start=()=>{writeFileSync(${JSON.stringify(forbidden)},'start');throw Error('registration must not start a turn')};
adapter.modes.hosted.openContinuation=${options.malformedOpen ? "null" : `()=>{writeFileSync(${JSON.stringify(forbidden)},'open');throw Error('registration must not configure a session')}`};
export default adapter;\n// generation ${options.generation ?? "A"}\n`;
  }
  writeFileSync(join(installed, "index.js"), source());
  const adapters = loadAdapters({ file: join(root, "adapters.json") });
  const selected = await adapters.add(installed);
  const artifacts = new WorkArtifactStore(join(root, "artifacts"), 256 * 1024 * 1024);
  let db = new Database(join(root, "registry.db"));
  const make = () => new WorkflowRuntimeRegistry({ db, artifacts, adapters, spoolRoot: spool, allowedRoots: [root],
    workerEntrypoint: fileURLToPath(new URL("../../../bags/sessions/api/src/workflow-harness-child.ts", import.meta.url)) });
  let registry = make();
  function groups() {
    const rows = db.prepare("SELECT handle_json FROM workflow_runtime_generations WHERE handle_json IS NOT NULL").all() as { handle_json: string }[];
    return rows.map(row => JSON.parse(row.handle_json) as { pgid: number });
  }
  const absent = (pgid: number) => { try { process.kill(-pgid, 0);return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;throw error; } };
  return { root, installed, spool, selected, adapters, artifacts, marker, forbidden,
    get registry() { return registry; },get db() { return db; },
    replace(options: Parameters<typeof source>[0]) { writeFileSync(join(installed, "index.js"), source(options)); },
    readMarker() { return JSON.parse(readFileSync(marker, "utf8")) as { argv: string[]; env: Record<string, string>; pid: number }; },
    removeInstalled() { rmSync(installed, { recursive: true, force: true }); },
    reopen() { db.close();db = new Database(join(root, "registry.db"));registry = make(); },
    assertNoApplicationInput() { assert.equal(existsSync(forbidden), false); },
    async close(preserve = false) {
      const handles = groups();
      assert.ok(handles.every(handle => absent(handle.pgid)), `Unknown registration group; preserve ${root}`);
      db.close();artifacts.close();if (!preserve) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The actual compiled Pi package selected through the installed registry and
 * production startup helper. No provider/session configuration is constructed. */
export async function installedPiRuntimeRegistration() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-registration-pi-")));
  const workspace = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
  const adapter = fileURLToPath(new URL("../../../adapters/sessions/pi/", import.meta.url));
  let dependencies = realpathSync(join(adapter, "node_modules", "@earendil-works", "pi-coding-agent"));
  while (!dependencies.endsWith("/.pnpm")) {
    const parent = join(dependencies, "..");const canonical = realpathSync(parent);
    assert.notEqual(canonical, dependencies, "Expected explicit pnpm package instance root");dependencies = canonical;
  }
  const adapters = loadAdapters({ file: join(root, "adapters.json") }), selected = await adapters.add(adapter);
  const config = join(root, "registration.json"), directory = join(root, "runtimes");
  writeFileSync(config, JSON.stringify({ version: 1, harnesses: [selected.id], allowedRoots: [workspace, dependencies], registrationTimeoutMs: 120000 }), { mode: 0o600 });
  let resource: Awaited<ReturnType<typeof registerInstalledWorkflowRuntimes>> | undefined;
  return { root, selected, directory,
    async start() { resource = await registerInstalledWorkflowRuntimes({ configuration: config, directory, adapters });return resource; },
    rows() {
      const db = new Database(join(directory, "generations.db"), { readonly: true });
      try { return db.prepare("SELECT generation,harness,runtime_json,state,handle_json FROM workflow_runtime_generations").all() as { generation: string; harness: string; runtime_json: string; state: string; handle_json: string }[]; }
      finally { db.close(); }
    },
    async close(preserve = false) {
      resource?.close();
      if (existsSync(join(directory, "generations.db"))) {
        const db = new Database(join(directory, "generations.db"), { readonly: true });
        try {
          for (const row of db.prepare("SELECT handle_json FROM workflow_runtime_generations WHERE handle_json IS NOT NULL").all() as { handle_json: string }[]) {
            const handle = JSON.parse(row.handle_json) as { pgid: number };let absent = false;
            try { process.kill(-handle.pgid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") absent = true;else throw error; }
            assert.ok(absent, "Unknown installed Pi registration group; preserve " + root);
          }
        } finally { db.close(); }
      }
      if (!preserve) rmSync(root, { recursive: true, force: true });
    },
  };
}
