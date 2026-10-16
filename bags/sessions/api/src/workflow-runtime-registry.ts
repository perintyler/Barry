/** Sessions-owned captured generations; independent of the interactive catalog. */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import {
  findInstalled,
  type InstalledAdapter,
  type Adapters,
} from "@barry-rocks/sdk/adapters/harnesses";
import {
  readInstalledAdapterPackage,
  type InstalledAdapterSelection,
} from "@barry-rocks/sdk/internal/adapters";
import type { WorkArtifactStore } from "@barry-rocks/sdk/internal/workflows";
import { canonicalWorkflowHarnessJson } from "./workflow-harness-protocol.js";
import {
  captureWorkflowRuntime,
  workflowRuntimeReferenceSchema,
  type WorkflowRuntimeReference,
} from "./workflow-runtime-closure.js";
import { installedWorkflowDeclaration } from "./workflow-runtime-registration-contract.js";
import { probeWorkflowRuntimeRegistration } from "./workflow-runtime-registration-probe.js";

export interface RegisteredWorkflowRuntime {
  generation: string;
  harness: string;
  runtime: WorkflowRuntimeReference;
  recordHash: string;
}
const WORKFLOW_RUNTIME_REGISTRY_VERSION = 1;
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalWorkflowHarnessJson(value)).digest("hex");
type Row = {
  generation: string;
  harness: string;
  runtime_json: string;
  record_hash: string;
  state: string;
};

const GENERATIONS_COLS = [
  "generation:TEXT:0:1",
  "harness:TEXT:1:0",
  "runtime_json:TEXT:1:0",
  "record_hash:TEXT:1:0",
  "record_json:TEXT:1:0",
  "state:TEXT:1:0",
  "probe_directory:TEXT:1:0",
  "handle_json:TEXT:0:0",
  "failure:TEXT:0:0",
].join(",");
const CURRENT_COLS = ["harness:TEXT:0:1", "generation:TEXT:1:0"].join(",");
function tableCols(db: Database.Database, table: string): string {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[]
  )
    .map((c) => `${c.name}:${c.type.toUpperCase()}:${c.notnull}:${c.pk}`)
    .join(",");
}
function assertValidRuntimeRegistrySchema(db: Database.Database): void {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (!Number.isInteger(version) || version < 0 || version > WORKFLOW_RUNTIME_REGISTRY_VERSION) {
    throw new Error("WorkflowRuntimeRegistryVersionUnsupported");
  }
  const objects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { type: string; name: string }[];
  if (objects.length === 0) {
    if (version !== 0) throw new Error("WorkflowRuntimeRegistryVersionUnsupported");
    return;
  }
  if (
    objects.length !== 2 ||
    objects[0]?.type !== "table" ||
    objects[0]?.name !== "workflow_runtime_current" ||
    objects[1]?.type !== "table" ||
    objects[1]?.name !== "workflow_runtime_generations" ||
    tableCols(db, "workflow_runtime_generations") !== GENERATIONS_COLS ||
    tableCols(db, "workflow_runtime_current") !== CURRENT_COLS ||
    db
      .prepare(
        "SELECT 1 FROM workflow_runtime_generations WHERE NOT json_valid(runtime_json) OR NOT json_valid(record_json) LIMIT 1",
      )
      .get()
  ) {
    throw new Error("WorkflowRuntimeRegistryVersionUnsupported");
  }
}

export class WorkflowRuntimeRegistry {
  private readonly options: {
    db: Database.Database;
    artifacts: WorkArtifactStore;
    adapters: Pick<Adapters, "installed"> & InstalledAdapterSelection;
    workerEntrypoint: string;
    allowedRoots: string[];
    spoolRoot: string;
    runtime?: string;
  };
  constructor(options: WorkflowRuntimeRegistry["options"]) {
    this.options = { ...options, allowedRoots: [...options.allowedRoots] };
    const spool = lstatSync(options.spoolRoot);
    if (
      !isAbsolute(options.spoolRoot) ||
      spool.isSymbolicLink() ||
      realpathSync(options.spoolRoot) !== options.spoolRoot ||
      !spool.isDirectory() ||
      (spool.mode & 0o077) !== 0 ||
      (process.getuid && spool.uid !== process.getuid())
    )
      throw new Error("WorkflowRuntimeRegistrySpoolUnavailable");
    assertValidRuntimeRegistrySchema(options.db);
    // Version 1 is the first stamped schema; validated legacy v0 stores adopt it in place.
    // An unrecognized or newer build's store is refused before any DDL or WAL mutation.
    options.db
      .transaction(() => {
        assertValidRuntimeRegistrySchema(options.db);
        options.db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_runtime_generations (
          generation TEXT PRIMARY KEY, harness TEXT NOT NULL, runtime_json TEXT NOT NULL,
          record_hash TEXT NOT NULL, record_json TEXT NOT NULL, state TEXT NOT NULL,
          probe_directory TEXT NOT NULL, handle_json TEXT, failure TEXT
        );
        CREATE TABLE IF NOT EXISTS workflow_runtime_current (harness TEXT PRIMARY KEY, generation TEXT NOT NULL);
      `);
        options.db.pragma(`user_version = ${WORKFLOW_RUNTIME_REGISTRY_VERSION}`);
      })
      .immediate();
  }

  private pointer(harness: string): string | undefined {
    return (
      this.options.db
        .prepare("SELECT generation FROM workflow_runtime_current WHERE harness=?")
        .get(harness) as { generation: string } | undefined
    )?.generation;
  }
  get(generation: string): RegisteredWorkflowRuntime | undefined {
    const row = this.options.db
      .prepare(
        "SELECT * FROM workflow_runtime_generations WHERE generation=? AND state='qualified'",
      )
      .get(generation) as Row | undefined;
    return (
      row && {
        generation: row.generation,
        harness: row.harness,
        recordHash: row.record_hash,
        runtime: workflowRuntimeReferenceSchema.parse(JSON.parse(row.runtime_json)),
      }
    );
  }
  /** Historical declaration from the same qualified publication, never the mutable catalog. */
  descriptor(
    generation: string,
  ): { registration: RegisteredWorkflowRuntime; record: InstalledAdapter } | undefined {
    const registration = this.get(generation);
    if (!registration) return undefined;
    const row = this.options.db
      .prepare(
        "SELECT record_json FROM workflow_runtime_generations WHERE generation=? AND state='qualified'",
      )
      .get(generation) as { record_json: string } | undefined;
    if (!row) return undefined;
    const record = JSON.parse(row.record_json) as InstalledAdapter;
    if (hash(record) !== registration.recordHash || record.id !== registration.harness)
      throw new Error("WorkflowRuntimeDeclarationChanged");
    installedWorkflowDeclaration(record);
    return { registration, record };
  }
  current(harness: string): RegisteredWorkflowRuntime | undefined {
    const selected = findInstalled(this.options.adapters.installed(), harness);
    if (!selected) return undefined;
    const generation = this.pointer(selected.id),
      retained = generation ? this.get(generation) : undefined;
    return retained && retained.recordHash === hash(selected) ? retained : undefined;
  }

  async register(harness: string, deadline: number): Promise<RegisteredWorkflowRuntime> {
    if (!Number.isFinite(deadline) || deadline <= Date.now())
      throw new Error("WorkflowRuntimeRegistrationExpired");
    const selected = structuredClone(findInstalled(this.options.adapters.installed(), harness));
    if (!selected) throw new Error("WorkflowRuntimeAdapterNotInstalled");
    if (
      selected.vendorCode ||
      selected.modes.hosted?.approvalContinuation !== "durable" ||
      selected.modes.hosted.guarantees.gating !== "per-call"
    )
      throw new Error("WorkflowRuntimeAdapterUnsupported");
    const expected = installedWorkflowDeclaration(selected),
      recordHash = hash(selected),
      previous = this.pointer(selected.id);
    // Resolve compiled entry without loading an original-path adapter object or
    // treating a catalog version/import cache as executable identity.
    const pkg = readInstalledAdapterPackage(selected.path);
    if (pkg.name !== selected.packageName || pkg.version !== selected.version)
      throw new Error("WorkflowRuntimePackageSelectionChanged");
    const runtime = captureWorkflowRuntime({
      artifacts: this.options.artifacts,
      harness: selected.id,
      adapterModule: pathToFileURL(join(selected.path, pkg.entry)).href,
      workerEntrypoint: this.options.workerEntrypoint,
      allowedRoots: this.options.allowedRoots,
      ...(this.options.runtime ? { runtime: this.options.runtime } : {}),
    });
    const generation = randomUUID(),
      directory = join(this.options.spoolRoot, generation),
      db = this.options.db;
    db.prepare(
      "INSERT INTO workflow_runtime_generations (generation,harness,runtime_json,record_hash,record_json,state,probe_directory) VALUES (?,?,?,?,?,'probing',?)",
    ).run(
      generation,
      selected.id,
      canonicalWorkflowHarnessJson(runtime),
      recordHash,
      canonicalWorkflowHarnessJson(selected),
      directory,
    );
    try {
      await probeWorkflowRuntimeRegistration({
        artifacts: this.options.artifacts,
        runtime,
        harness: selected.id,
        directory,
        declaration: expected,
        deadline,
        packageName: selected.packageName,
        packageVersion: selected.version,
        recordHandle: (handle) => {
          db.prepare(
            "UPDATE workflow_runtime_generations SET handle_json=? WHERE generation=? AND state='probing'",
          ).run(canonicalWorkflowHarnessJson(handle), generation);
        },
      });
      this.options.adapters.withSelection(harness, (current) =>
        db.transaction(() => {
          if (
            !current ||
            hash(current) !== recordHash ||
            this.pointer(selected.id) !== previous ||
            Date.now() >= deadline
          )
            throw new Error("WorkflowRuntimeRegistrationSelectionChanged");
          db.prepare(
            "UPDATE workflow_runtime_generations SET state='qualified' WHERE generation=? AND state='probing'",
          ).run(generation);
          db.prepare(
            "INSERT INTO workflow_runtime_current (harness,generation) VALUES (?,?) ON CONFLICT(harness) DO UPDATE SET generation=excluded.generation",
          ).run(selected.id, generation);
        })(),
      );
      return this.get(generation)!;
    } catch (error) {
      // No failed/uncertain probe can become a dispatchable generation. Keep
      // its exact handle/location for diagnosis; no stored-PID recovery signal.
      db.prepare(
        "UPDATE workflow_runtime_generations SET state='refused',failure=? WHERE generation=? AND state='probing'",
      ).run(error instanceof Error ? error.name : "RegistrationFailure", generation);
      throw error;
    }
  }
}
