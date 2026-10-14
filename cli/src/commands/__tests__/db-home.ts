import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, vi } from "vitest";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { ProcessExecutor, WorkflowOwner, inspectArtifact } from "@barry-rocks/sdk/internal/workflows";
import { managedStoreRegistry } from "../db-stores.js";

const original = process.env.BARRY_HOME;
const scratch: string[] = [];
afterEach(() => {
  process.env.BARRY_HOME = original;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
export function directory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}
const artifactPath = fileURLToPath(new URL("../../../../sdk/src/workflows/execution-fixture.mjs", import.meta.url));

/** A home on the generation layout with one identity's session and a paused-worthy workflow run. */
export async function sourceHome(): Promise<{ installation: string; identity: string; root: string }> {
  process.env.BARRY_HOME = directory("barry-db-source-");
  vi.stubEnv("BARRY_CONFIG_ALLOW_EMPTY", "1");
  // The suite points these at legacy files; a generation home resolves its own.
  for (const name of ["BARRY_IDENTITIES_DB", "BARRY_SESSIONS_DB", "BARRY_ACTIONS_DB", "BARRY_SCHEDULES_DB"]) vi.stubEnv(name, undefined);
  mkdirSync(join(process.env.BARRY_HOME, "app-support"), { recursive: true });
  const root = barryStoresDir(), generation = join(root, "generations", "g1");
  mkdirSync(generation, { recursive: true });
  writeFileSync(join(root, "active.json"), JSON.stringify({ id: "g1" }));
  const nodes = new NodeRegistry(join(generation, "node", "nodes"));
  const installation = nodes.id, identity = nodes.identityId(1);
  nodes.close();
  const { registry } = await managedStoreRegistry(installation, activeStoreRoot());
  (await registry.open({ node: installation, identity, bag: "sessions", store: "sessions" })).close();
  const sessions = new DatabaseSync(join(generation, "identities", identity, "sessions", "sessions.db"));
  try {
    sessions.exec("INSERT INTO sessions(id) VALUES('session-1'); INSERT INTO messages(id, session_id, type) VALUES('message-1', 'session-1', 'text')");
  } finally { sessions.close(); }
  const workflows = join(generation, "node", "workflows", "workflows.db");
  mkdirSync(join(workflows, ".."), { recursive: true });
  const artifacts = [inspectArtifact(artifactPath, "echo", "1")];
  const owner = new WorkflowOwner({ id: installation, path: workflows, artifacts, activityArtifacts: { echo: artifacts[0].digest }, executor: new ProcessExecutor() });
  owner.start({ id: "run-1", type: "echo", version: "1", input: "durable" });
  await owner.pump();
  await owner.drain(); owner.close();
  // A store no bag declares still has to come back.
  mkdirSync(join(generation, "node", "retired"), { recursive: true });
  const loose = new DatabaseSync(join(generation, "node", "retired", "leftover.db"));
  try { loose.exec("CREATE TABLE held(name TEXT); INSERT INTO held VALUES('kept')"); } finally { loose.close(); }
  return { installation, identity, root };
}

/** Two running user services, a stopped one and a running system service; `on` runs inside a stop or a status read. */
export function serviceFixture(on: { stop?(key: string): void; status?(): void } = {}) {
  const states = new Map([ ["sessions.api", true], ["mcp.server", true], ["disabled.web", false], ["vault.api", true] ]);
  const stopped: string[] = [], started: string[] = [], roots: string[] = [];
  return { states, stopped, started, roots, services: {
    statuses: async () => { on.status?.(); return [...states].map(([key, running]) => ({ key, pid: running ? 123 : undefined, state: running ? "running" as const : "stopped" as const })); },
    isSystem: (key: string) => key === "vault.api",
    stop: async (key: string) => { stopped.push(key); states.set(key, false); on.stop?.(key); },
    start: async (key: string) => { started.push(key); roots.push(activeStoreRoot()); states.set(key, true); },
  } };
}
