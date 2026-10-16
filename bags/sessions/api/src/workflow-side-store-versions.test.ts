/** Schema version of the Sessions-owned workflow side stores (G5, T-UP2; D8 L155 / UP1).
 * Real startup filesystem/SQLite ownership; only registry.register is mocked,
 * exactly as in workflow-runtime-installation.test.ts. The executor journal
 * contrast (refuses a newer user_version) is already pinned by
 * sdk/src/workflows/executor-journal.test.ts:707-717 ("refuses wrong installation
 * and future journal schema", user_version=999), so it is not repeated here. */
import Database from "better-sqlite3";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import type { WorkArtifactStore } from "@barry-rocks/sdk/internal/workflows";
import { registerInstalledWorkflowRuntimes } from "./workflow-runtime-installation.js";
import { WorkflowRuntimeRegistry } from "./workflow-runtime-registry.js";
import { WorkflowWorkSessions } from "./workflow-work-sessions.js";

const disposals: (() => void | Promise<void>)[] = [];
const register = vi.spyOn(WorkflowRuntimeRegistry.prototype, "register");
beforeEach(() => {
  register.mockReset();
});
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});
type RegistryInputs = { db: Database.Database; artifacts: WorkArtifactStore; spoolRoot: string };
function inputs(registry: WorkflowRuntimeRegistry): RegistryInputs {
  return Reflect.get(registry, "options") as RegistryInputs;
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-unversioned-stores-")));
  disposals.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "service"),
    configuration = join(root, "installation.json");
  const adapters = {
    installed: () => [],
    withSelection<T>(_id: string, operation: (record: InstalledAdapter | undefined) => T): T {
      return operation(undefined);
    },
  };
  writeFileSync(
    configuration,
    JSON.stringify({
      version: 1,
      harnesses: ["first"],
      allowedRoots: [root],
      registrationTimeoutMs: 30000,
    }),
    { mode: 0o600 },
  );
  register.mockImplementation(async function (this: WorkflowRuntimeRegistry, harness: string) {
    const { db, artifacts, spoolRoot } = inputs(this);
    const bytes = artifacts.stage(Buffer.from("mock registration metadata for " + harness), {
      purpose: "source",
      owner_identity: null,
      media_type: "application/octet-stream",
    });
    const runtime = {
        version: 1 as const,
        protocol: 1 as const,
        digest: bytes.digest,
        bytes: bytes.bytes,
      },
      generation = "mock-generation-" + harness;
    db.prepare(
      "INSERT OR IGNORE INTO workflow_runtime_generations (generation,harness,runtime_json,record_hash,record_json,state,probe_directory) VALUES (?,?,?,?,?,'qualified',?)",
    ).run(generation, harness, JSON.stringify(runtime), "mock-record-hash", "{}", spoolRoot);
    return { generation, harness, runtime, recordHash: "mock-record-hash" };
  });
  const start = async () => {
    const service = await registerInstalledWorkflowRuntimes({ configuration, directory, adapters });
    disposals.push(service.close);
    return service;
  };
  return { root, directory, start };
}
const userVersion = (path: string) => {
  const db = new Database(path);
  try {
    return db.pragma("user_version", { simple: true });
  } finally {
    db.close();
  }
};

it("stamps generations.db at version 1, adopts a valid unstamped store, and refuses newer or malformed schemas byte-for-byte unchanged", async () => {
  const f = fixture(),
    path = join(f.directory, "generations.db");
  const first = await f.start();
  expect(first.registrations.map((row) => row.generation)).toEqual(["mock-generation-first"]);
  expect(inputs(first.registry).db.pragma("user_version", { simple: true })).toBe(1);
  first.close();

  // A store written before versioning has the version 1 schema and is adopted in place.
  const unstamped = new Database(path);
  unstamped.pragma("user_version = 0");
  unstamped.close();
  const adopted = await f.start();
  expect(adopted.registry.get("mock-generation-first")).toEqual(first.registrations[0]);
  adopted.close();
  expect(userVersion(path)).toBe(1);

  const newer = new Database(path);
  newer.pragma("journal_mode = DELETE");
  newer.exec("ALTER TABLE workflow_runtime_generations ADD COLUMN future_lineage TEXT;");
  newer.pragma("user_version = 2");
  newer.close();
  const newerBytes = readFileSync(path);
  await expect(f.start()).rejects.toThrow("WorkflowRuntimeRegistryVersionUnsupported");
  expect(readFileSync(path).equals(newerBytes)).toBe(true);
  expect(existsSync(`${path}-wal`)).toBe(false);
  expect(userVersion(path)).toBe(2);

  // An unstamped store with an unrecognized schema or corrupt JSON row is refused without stamping.
  rmSync(path, { force: true });
  const malformed = new Database(path, { fileMustExist: false });
  malformed.exec(`
    CREATE TABLE workflow_runtime_generations (generation TEXT PRIMARY KEY, harness TEXT NOT NULL);
    CREATE TABLE workflow_runtime_current (harness TEXT PRIMARY KEY, generation TEXT NOT NULL);
  `);
  malformed.close();
  chmodSync(path, 0o600);
  const malformedBytes = readFileSync(path);
  await expect(f.start()).rejects.toThrow("WorkflowRuntimeRegistryVersionUnsupported");
  expect(readFileSync(path).equals(malformedBytes)).toBe(true);
  expect(userVersion(path)).toBe(0);
});

it("stamps accepted-work.sqlite at version 1, adopts a valid unstamped store, and refuses newer or tampered schemas byte-for-byte unchanged", async () => {
  const f = fixture(),
    installation = await f.start(),
    directory = join(f.root, "work"),
    path = join(directory, "accepted-work.sqlite");
  const open = () => {
    const sessions = new WorkflowWorkSessions({
      installation,
      directory,
      clients: new Map(),
      artifacts: installation.artifacts,
    });
    disposals.push(() => sessions.close());
    return sessions;
  };
  const first = open();
  const db = Reflect.get(first, "db") as Database.Database;
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  db.prepare("INSERT INTO accepted_work VALUES(?,?,?)").run(
    "retained-key",
    "a".repeat(64),
    '{"version":1}',
  );
  await first.close();

  const unstamped = new Database(path);
  unstamped.pragma("user_version = 0");
  unstamped.close();
  const adopted = open(),
    adoptedDb = Reflect.get(adopted, "db") as Database.Database;
  expect(adoptedDb.prepare("SELECT key FROM accepted_work").all()).toEqual([
    { key: "retained-key" },
  ]);
  expect(() => adoptedDb.prepare("DELETE FROM accepted_work").run()).toThrow(
    "accepted work is immutable",
  );
  await adopted.close();
  expect(userVersion(path)).toBe(1);

  // Dropping an immutability trigger on a stamped v1 store refuses instead of silently recreating it.
  const tampered = new Database(path);
  tampered.pragma("journal_mode = DELETE");
  tampered.exec("DROP TRIGGER accepted_work_immutable_delete;");
  tampered.close();
  const tamperedBytes = readFileSync(path);
  expect(() => open()).toThrow("WorkSessionsAuthorityVersionUnsupported");
  expect(readFileSync(path).equals(tamperedBytes)).toBe(true);
  expect(existsSync(`${path}-wal`)).toBe(false);

  // Restore trigger, then test future version refusal byte-for-byte.
  const restored = new Database(path);
  restored.exec(
    "CREATE TRIGGER accepted_work_immutable_delete BEFORE DELETE ON accepted_work BEGIN SELECT RAISE(ABORT,'accepted work is immutable'); END;",
  );
  restored.exec("CREATE TABLE accepted_work_future (id TEXT PRIMARY KEY);");
  restored.pragma("user_version = 2");
  restored.close();
  const newerBytes = readFileSync(path);
  expect(() => open()).toThrow("WorkSessionsAuthorityVersionUnsupported");
  expect(readFileSync(path).equals(newerBytes)).toBe(true);
  expect(userVersion(path)).toBe(2);
});
