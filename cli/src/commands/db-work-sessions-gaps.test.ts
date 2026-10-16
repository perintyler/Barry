import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { bagDataDir, barryAppSupportDir } from "@barry-rocks/sdk/services";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { WorkArtifactStore } from "@barry-rocks/sdk/internal/workflows";
import { WorkflowRuntimeRegistry } from "../../../bags/sessions/api/src/workflow-runtime-registry.js";
import { directory, sourceHome } from "./__tests__/db-home.js";
import { backedUpDataStores, UNMANAGED_DATA_DIR } from "./db-stores.js";
import { dbBackupCommand } from "./db.js";
import { dbRestoreCommand } from "./db-restore.js";

// Work→Sessions operations gaps (report §2 G1/G3, matrix T-BR1/T-BR4).
const noServices = { statuses: async () => [], isSystem: () => false, stop: async () => {}, start: async () => {} };

/** Every regular file under `root`, relative to it, sorted. */
function files(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(root, path));
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The nested Work→Sessions state at the locations the sessions service resolves
 * (`bags/sessions/api/src/index.ts`): `<data/sessions>/workflow-runtimes` and
 * `<data/sessions>/workflow-authorities`. generations.db gets its schema from
 * the real WorkflowRuntimeRegistry constructor; one qualified generation row
 * stands in for a registration (registering needs a native adapter probe).
 */
function nestedWorkSessionsState(): { runtimes: string; authorities: string; generation: string } {
  const runtimes = join(bagDataDir("sessions"), "workflow-runtimes");
  mkdirSync(join(runtimes, "registration-spool"), { recursive: true, mode: 0o700 });
  const spoolRoot = realpathSync(join(runtimes, "registration-spool"));
  const generations = new Database(join(runtimes, "generations.db"));
  const generation = "6b0f7c55-1f6e-4c4e-9d0a-3a3f0d1e2c41";
  try {
    generations.pragma("journal_mode=WAL");
    const artifacts = new WorkArtifactStore(join(runtimes, "artifacts"));
    try {
      new WorkflowRuntimeRegistry({ db: generations, artifacts, spoolRoot, allowedRoots: [runtimes], workerEntrypoint: join(runtimes, "worker.js"),
        adapters: { installed: () => [], withSelection: (_id, operation) => operation(undefined) } });
      artifacts.stage(Buffer.from("captured runtime closure"), { purpose: "source", owner_identity: null, media_type: "application/octet-stream" });
    } finally { artifacts.close(); }
    generations.prepare("INSERT INTO workflow_runtime_generations (generation,harness,runtime_json,record_hash,record_json,state,probe_directory) VALUES (?,?,?,?,?,'qualified',?)")
      .run(generation, "pi", "{}", "a".repeat(64), "{}", join(spoolRoot, generation));
    generations.prepare("INSERT INTO workflow_runtime_current (harness,generation) VALUES ('pi',?)").run(generation);
  } finally { generations.close(); }
  const result = join(runtimes, "execution-spool", "c".repeat(64));
  mkdirSync(result, { recursive: true, mode: 0o700 });
  writeFileSync(join(result, "binding.json"), JSON.stringify({ version: 1, session_id: "session-1" }));
  writeFileSync(join(result, "result.json"), JSON.stringify({ version: 1, output: "model output that outcome recovery repairs from" }));

  // Worker-dir-shaped authority state nested under the authorities directory:
  // an accepted-work journal (DDL from workflow-work-sessions.ts) and a private session home.
  const authorities = join(bagDataDir("sessions"), "workflow-authorities");
  mkdirSync(join(authorities, "session-1", "barry"), { recursive: true, mode: 0o700 });
  const accepted = new DatabaseSync(join(authorities, "accepted-work.sqlite"));
  try {
    accepted.exec(`CREATE TABLE accepted_work (key TEXT PRIMARY KEY, authority_hash TEXT NOT NULL CHECK(length(authority_hash)=64), authority_json TEXT NOT NULL CHECK(json_valid(authority_json)));
      INSERT INTO accepted_work VALUES ('work-1', '${"b".repeat(64)}', '{"generation":"${generation}"}');`);
  } finally { accepted.close(); }
  const home = new DatabaseSync(join(authorities, "session-1", "barry", "state.db"));
  try { home.exec("CREATE TABLE t(x TEXT); INSERT INTO t VALUES('home')"); } finally { home.close(); }
  return { runtimes, authorities, generation };
}

/** A depth-1 side store in a bag's data directory, as the Work executor keeps one. */
function sideStore(bag: string, file: string, row: string): string {
  const path = join(bagDataDir(bag), file);
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS execution_receipts(id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO execution_receipts VALUES(?)").run(row);
  } finally { db.close(); }
  return path;
}

// T-BR1 (G1, D11/P7.4): the nested Work→Sessions stores and the evidence trees they point at are in the backup.
it("backs up nested Sessions workflow stores and evidence trees and lists them for manual restore", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await sourceHome();
  const { runtimes, authorities, generation } = nestedWorkSessionsState();
  sideStore("workflows", "work-executor.db", "receipt-1");
  sideStore("sessions", "work-admission-issuer.db", "issued-1");

  const backup = join(directory("barry-work-sessions-backup-"), "backup");
  await dbBackupCommand(backup, { vault: false });

  // Every SQLite store under the data directories, nested ones included, then the evidence trees.
  expect(backedUpDataStores(backup)).toEqual([
    "sessions/work-admission-issuer.db",
    "sessions/workflow-authorities/accepted-work.sqlite",
    "sessions/workflow-authorities/session-1/barry/state.db",
    "sessions/workflow-runtimes/generations.db",
    "workflows/work-executor.db",
    "sessions/workflow-runtimes/artifacts/",
    "sessions/workflow-runtimes/execution-spool/",
  ]);
  const data = join(backup, UNMANAGED_DATA_DIR, "sessions");
  const copied = new DatabaseSync(join(data, "workflow-runtimes", "generations.db"), { readOnly: true });
  try { expect(copied.prepare("SELECT generation, state FROM workflow_runtime_generations").all()).toEqual([{ generation, state: "qualified" }]); }
  finally { copied.close(); }
  const accepted = new DatabaseSync(join(data, "workflow-authorities", "accepted-work.sqlite"), { readOnly: true });
  try { expect(accepted.prepare("SELECT key FROM accepted_work").all()).toEqual([{ key: "work-1" }]); } finally { accepted.close(); }
  const spool = join("workflow-runtimes", "execution-spool", "c".repeat(64));
  for (const file of ["binding.json", "result.json"]) expect(readFileSync(join(data, spool, file), "utf8")).toBe(readFileSync(join(bagDataDir("sessions"), spool, file), "utf8"));
  expect(files(join(data, "workflow-runtimes", "artifacts"))).toEqual(files(join(runtimes, "artifacts")));

  const printed = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].map(call => String(call[0])).join("\n");
  expect(printed).toContain("unmanaged/data/sessions/workflow-runtimes/generations.db (kept outside the store generation; see RESTORE.md)");
  expect(printed).toContain("unmanaged/data/sessions/workflow-authorities/accepted-work.sqlite (kept outside the store generation; see RESTORE.md)");
  expect(printed).toContain("unmanaged/data/sessions/workflow-runtimes/execution-spool/ (2 files Sessions workflow recovery reads; see RESTORE.md)");
  expect(warn).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  const restoreMd = readFileSync(join(backup, "RESTORE.md"), "utf8");
  expect(restoreMd).toContain("sessions/workflow-runtimes/generations.db");
  expect(restoreMd).toContain("`sessions/workflow-runtimes/artifacts/`, `sessions/workflow-runtimes/execution-spool/`");
  expect(restoreMd).toContain('cp -Rn "unmanaged/data/<tree>/"');
  expect(existsSync(join(authorities, "accepted-work.sqlite"))).toBe(true);

  // Restore still leaves them for the operator (a generation switch cannot undo in-place writes), naming each destination.
  log.mockClear();
  process.env.BARRY_HOME = directory("barry-work-sessions-restore-");
  await dbRestoreCommand(backup, { services: noServices });
  const sessionsData = bagDataDir("sessions", { create: false });
  expect(existsSync(join(sessionsData, "workflow-runtimes"))).toBe(false);
  const restored = log.mock.calls.map(call => String(call[0])).join("\n");
  expect(restored).toContain(`unmanaged/data/sessions/workflow-runtimes/generations.db -> ${join(sessionsData, "workflow-runtimes", "generations.db")}`);
  expect(restored).toContain(`unmanaged/data/sessions/workflow-runtimes/execution-spool/ -> ${join(sessionsData, "workflow-runtimes", "execution-spool")}/`);
}, 60000);

// Target (T-BR4, D11 "consistent backup"): restoring an older managed generation must refuse until side stores are
// reverted/fenced, or block newer side-store receipts with an audit row — never leave them silently newer; flip this assertion when fixed.
it("gap G3: restore rolls managed stores back but leaves a mutated depth-1 side store at its post-backup state, listing it for manual action", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { identity } = await sourceHome();
  const executor = sideStore("workflows", "work-executor.db", "receipt-before-backup");
  const backup = join(directory("barry-work-sessions-side-"), "backup");
  await dbBackupCommand(backup, { vault: false });

  // After the backup: a managed store and the side store both move forward.
  const sessionsPath = join(activeStoreRoot(), "identities", identity, "sessions", "sessions.db");
  const sessions = new DatabaseSync(sessionsPath);
  try { sessions.exec("INSERT INTO sessions(id) VALUES('session-after-backup')"); } finally { sessions.close(); }
  sideStore("workflows", "work-executor.db", "receipt-after-backup");

  log.mockClear();
  await dbRestoreCommand(backup, { services: noServices });
  const output = log.mock.calls.map(call => String(call[0])).join("\n");

  // Managed stores went back to the backup.
  const restored = new DatabaseSync(join(activeStoreRoot(), "identities", identity, "sessions", "sessions.db"), { readOnly: true });
  try { expect(restored.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: "session-1" }]); } finally { restored.close(); }
  const workflows = new DatabaseSync(join(activeStoreRoot(), "node", "workflows", "workflows.db"), { readOnly: true });
  try { expect(workflows.prepare("SELECT status FROM workflow_runs WHERE id='run-1'").get()).toEqual({ status: "blocked" }); } finally { workflows.close(); }

  // The side store keeps the receipt the restored owner never saw.
  expect(executor).toBe(join(barryAppSupportDir(), "data", "workflows", "work-executor.db"));
  const side = new DatabaseSync(executor, { readOnly: true });
  try { expect(side.prepare("SELECT id FROM execution_receipts ORDER BY id").all()).toEqual([{ id: "receipt-after-backup" }, { id: "receipt-before-backup" }]); }
  finally { side.close(); }

  // Restore lists it for manual action instead of reconciling or refusing.
  expect(output).toContain("not restored, kept outside the store generation (RESTORE.md says how to put one back):");
  expect(output).toContain(`    unmanaged/data/workflows/work-executor.db -> ${executor}`);
  expect(output).toContain("1 workflow run(s) blocked (RecoveryPaused)");
  const restoreMd = readFileSync(join(backup, "RESTORE.md"), "utf8");
  expect(restoreMd).toContain("## Stores outside the generation");
  expect(restoreMd).toContain("`barry db restore` leaves them\nalone");
}, 60000);

// Target (T-BR5, G3): pauseRestoredRuns also blocks open Sessions segments (`ceased_at IS NULL`) under the recovery
// epoch; flip this assertion when fixed.
it("gap G3: restore pauses workflows.db runs under a new epoch but leaves open session_workflow_settlements untouched", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { identity } = await sourceHome();
  const before = new DatabaseSync(join(activeStoreRoot(), "node", "workflows", "workflows.db"), { readOnly: true });
  let epoch: unknown;
  try { epoch = before.prepare("SELECT value FROM workflow_meta WHERE key='epoch'").get()?.value; } finally { before.close(); }
  const sessions = new DatabaseSync(join(activeStoreRoot(), "identities", identity, "sessions", "sessions.db"));
  const turn = { id: "turn-1", session_id: "session-1", request_id: "request-1", request_hash: "d".repeat(64), input_json: "{}", actor: "workflow", state: "running", revision: 1, policy_json: "{}", run_id: "run-1", owner: "owner-1", created_at: "2026-10-15T00:00:00.000Z", updated_at: "2026-10-15T00:00:00.000Z" };
  const settlement = { segment_id: "segment-1", session_id: "session-1", turn_id: "turn-1", owner: "owner-1", phase: "handled", handle_json: JSON.stringify({ pid: 4242, hostname: "source-host", bootIdentity: "boot-1" }), input_at: null, closing_at: null, ceased_at: null, created_at: "2026-10-15T00:00:00.000Z", owner_process_json: null };
  try {
    sessions.prepare("INSERT INTO session_turns(id,session_id,request_id,request_hash,input_json,actor,state,revision,policy_json,run_id,owner,created_at,updated_at) VALUES(:id,:session_id,:request_id,:request_hash,:input_json,:actor,:state,:revision,:policy_json,:run_id,:owner,:created_at,:updated_at)").run(turn);
    sessions.prepare("INSERT INTO session_workflow_settlements(segment_id,session_id,turn_id,owner,phase,handle_json,created_at) VALUES(:segment_id,:session_id,:turn_id,:owner,:phase,:handle_json,:created_at)")
      .run({ segment_id: settlement.segment_id, session_id: settlement.session_id, turn_id: settlement.turn_id, owner: settlement.owner, phase: settlement.phase, handle_json: settlement.handle_json, created_at: settlement.created_at });
  } finally { sessions.close(); }
  const backup = join(directory("barry-work-sessions-settlement-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  await dbRestoreCommand(backup, { services: noServices });

  const workflows = new DatabaseSync(join(activeStoreRoot(), "node", "workflows", "workflows.db"), { readOnly: true });
  try {
    expect(workflows.prepare("SELECT status, error FROM workflow_runs WHERE id='run-1'").get()).toEqual({ status: "blocked", error: "RecoveryPaused: reconcile external effects before resume" });
    const restoredEpoch = workflows.prepare("SELECT value FROM workflow_meta WHERE key='epoch'").get()?.value;
    expect(restoredEpoch).toEqual(expect.any(String));
    expect(restoredEpoch).not.toBe(epoch);
    expect(JSON.parse(String(workflows.prepare("SELECT value FROM workflow_meta WHERE key='recovery-admission'").get()?.value))).toMatchObject({ version: 1, epoch: restoredEpoch, active: false });
  } finally { workflows.close(); }

  const restored = new DatabaseSync(join(activeStoreRoot(), "identities", identity, "sessions", "sessions.db"), { readOnly: true });
  try {
    expect(restored.prepare("SELECT * FROM session_workflow_settlements").all()).toEqual([settlement]);
    expect(restored.prepare("SELECT segment_id FROM session_workflow_settlements WHERE ceased_at IS NULL").all()).toEqual([{ segment_id: "segment-1" }]);
    expect(restored.prepare("SELECT state, revision, owner FROM session_turns WHERE id='turn-1'").get()).toEqual({ state: "running", revision: 1, owner: "owner-1" });
  } finally { restored.close(); }
}, 60000);
