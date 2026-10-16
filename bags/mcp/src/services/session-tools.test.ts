/**
 * `services_restart` through the real services and sessions subjects. The
 * caller the tool builds must be one the identities subject lets read its own
 * identity; otherwise no session's resolved tools ever reach the write check.
 * Identities are a fake that refuses what the real subject refuses.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { Barry, BarryError, type Bound, type Caller, type Identity, type Tool } from "@barry-rocks/sdk";
import { isToolAllowedByBound } from "@barry-rocks/sdk/bounds";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import { openInstance } from "@barry-rocks/sdk/internal/services";
import { ServiceManagement } from "./management.js";
import type { ServiceOS } from "./launchd.js";

const scratch = mkdtempSync(join(tmpdir(), "barry-mcp-session-tools-"));
process.env.BARRY_SESSIONS_DB = join(scratch, "sessions.db");

const injected = vi.hoisted(() => ({ management: vi.fn() }));
vi.mock("./control.js", async importOriginal => ({
  ...await importOriginal<typeof import("./control.js")>(),
  managedServices: injected.management,
}));
// Stores name a session's partition by its identity's UUID, which the node registry maps to the identity's id.
vi.mock("@barry-rocks/sdk/stores", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/stores")>(),
  sessionIdentity: () => "partition-bux",
}));
vi.mock("@barry-rocks/sdk/internal/nodes", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/nodes")>(),
  readLocalIdentities: () => new Map([["partition-bux", 7]]),
}));

const { sessions } = await import("@barry-rocks/sessions-bag");
const { getSessionsSqlite, closeSessionsDb } = await import("@barry-rocks/sessions-bag/store/sessions-db");
const { services } = await import("./subject.js");
const { servicesRestart } = await import("../tools.js");

const BUX: Identity = {
  id: 7, name: "bux", token: "token-bux", displayName: null, bags: [], bounds: [],
  adapters: {}, envKeys: [], vaultEmail: null,
  isDefault: false, createdAt: null, lastUsedAt: null,
};

/** The real identities subject's rule: a session reads only the identity it names by name or id. */
function readable(ref: string | number, caller: Caller): Identity {
  if (ref !== BUX.id && ref !== BUX.name) throw new BarryError("not_found", `Identity ${String(ref)} not found`);
  if (caller.kind === "session" && caller.identity !== BUX.name && caller.identity !== BUX.id) throw new BarryError("forbidden", "A session may read only its own identity");
  return BUX;
}

const MCP_TOOLS: Tool[] = [
  { name: "services_list", namespace: "mcp", bag: "mcp", access: "read" },
  { name: "services_status", namespace: "mcp", bag: "mcp", access: "read" },
  { name: "services_restart", namespace: "mcp", bag: "mcp", access: "write" },
];

let home: string, os: ServiceOS;
const context = { secrets: {}, sessionId: "s1" };
getSessionsSqlite()
  .prepare("INSERT INTO sessions (id, active, state, status, identity_id, user_id, bags, bounds, bound, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run("s1", 1, "open", "running", BUX.id, null, JSON.stringify(["mcp"]), JSON.stringify([]), null, "{}", new Date().toISOString());

function setSessionSelection(bags: string[], bounds: string[], bound: Bound | null) {
  getSessionsSqlite()
    .prepare("UPDATE sessions SET bags = ?, bounds = ?, bound = ? WHERE id = ?")
    .run(JSON.stringify(bags), JSON.stringify(bounds), bound ? JSON.stringify(bound) : null, "s1");
}

beforeEach(async () => {
  setSessionSelection(["mcp"], [], null);
  home = mkdtempSync(join(tmpdir(), "barry-mcp-session-tools-home-"));
  vi.stubEnv("BARRY_SERVICE", "");
  os = { inspect: vi.fn(() => ({ loaded: false })), load: vi.fn(), unload: vi.fn(async () => {}), enable: vi.fn(), start: vi.fn() };
  const management = new ServiceManagement(openInstance(home), [{ name: "fixture.api", command: [process.execPath], directory: home, domain: "gui/501", plistDirectory: home, logDirectory: home }], os);
  await management.apply("fixture.api", "add");
  injected.management.mockImplementation(() => management);
  Barry.use(services, sessions, fakeIdentities({
    get: async (ref, caller) => readable(ref, caller),
    bound: async (ref, bounds, caller) => {
      if (ref !== null) readable(ref, caller);
      return bounds?.includes("mcp:read") ? { tools: { deny: ["mcp:write"] } } : null;
    },
    tools: async (ref, selection, caller): Promise<Tool[]> => {
      if (ref !== null) readable(ref, caller);
      const packedBags = new Set(selection.bags ?? []);
      if (!packedBags.has("mcp")) return [];
      const activeBound: Bound | null =
        selection.bounds && !Array.isArray(selection.bounds)
          ? (selection.bounds as Bound)
          : Array.isArray(selection.bounds) && selection.bounds.includes("mcp:read")
            ? { tools: { deny: ["mcp:write"] } }
            : null;
      return MCP_TOOLS.filter(t =>
        isToolAllowedByBound({ namespace: t.namespace, toolName: t.name, access: t.access }, activeBound),
      );
    },
  }));
});
afterEach(() => { Barry.reset(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
afterAll(() => { closeSessionsDb(); rmSync(scratch, { recursive: true, force: true }); });

it("lets a session packing mcp restart, refuses when mcp is not packed, and refuses when bound by mcp:read", async () => {
  await servicesRestart.handler({ service: "fixture.api" }, context);
  expect(os.unload).toHaveBeenCalledOnce();

  setSessionSelection([], [], null);
  await expect(servicesRestart.handler({ service: "fixture.api" }, context)).rejects.toMatchObject({ reason: "forbidden" });
  expect(os.unload).toHaveBeenCalledOnce();

  setSessionSelection(["mcp"], ["mcp:read"], { tools: { deny: ["mcp:write"] } });
  await expect(servicesRestart.handler({ service: "fixture.api" }, context)).rejects.toMatchObject({ reason: "forbidden" });
  expect(os.unload).toHaveBeenCalledOnce();
});

it("refuses a session's restart of the process serving it as a conflict", async () => {
  vi.stubEnv("BARRY_SERVICE", "fixture.api");
  await expect(servicesRestart.handler({ service: "fixture.api" }, context)).rejects.toMatchObject({ reason: "conflict", hint: "barry service restart fixture.api" });
  expect(os.unload).not.toHaveBeenCalled();
});

it("cannot read the session's tools when the caller names its identity by partition", async () => {
  const byPartition: Caller = { kind: "session", identity: "partition-bux", sessionId: "s1" };
  await expect(Barry.as(byPartition).service("fixture.api").restart()).rejects.toMatchObject({ reason: "forbidden", message: "A session may read only its own identity" });
  expect(os.unload).not.toHaveBeenCalled();
});
