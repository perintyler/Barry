import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI_SCOPE } from "./scope.js";
import { withRunPolicy, assertRawScriptPolicy } from "./resource-scope.js";
import { currentStoreContext } from "@barry-rocks/sdk/internal/stores";
import { Barry } from "@barry-rocks/sdk";
import { bounds, identities, traits } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore } from "@barry-rocks/identities-bag/testing";
import { provisionOwner, seedIdentityRow } from "../test/helpers/identities.js";
import { scheduleContext } from "@barry-rocks/schedules-bag";
import { normalizeSchedule } from "@barry-rocks/sdk/internal/schedules";
import { closeInstallationRegistry } from "@barry-rocks/sdk/internal/nodes";
vi.mock("@barry-rocks/sdk/internal/tools", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/tools")>(),
  collectToolMeta: async () => [{ namespace: "bash", toolName: "Bash", access: "write" }],
}));
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "barry-cli-script-policy-"));
  closeIdentitiesStore();
  vi.stubEnv("BARRY_HOME", directory);
  vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db"));
  Barry.use(identities);
});
afterEach(() => {
  Barry.reset();
  closeInstallationRegistry();
  closeIdentitiesStore();
  delete (globalThis as Record<symbol, unknown>)[CLI_SCOPE];
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
/** The installation's traits, as a bag sync registers them. */
async function ensureFixtureTraits(): Promise<void> {
  await traits.ensure([
    ...["bash", "filesystem", "sessions", "instructions"].map(name => ({ name, namespaces: [name], access: "read" as const, bag: name })),
    { name: "writer", namespaces: ["bash"], access: "readwrite" as const, bag: "bash" },
  ], {});
}

it("resolves real stored identity traits and refuses a stored read-only Bash grant", async () => {
  await ensureFixtureTraits();
  const actorId = provisionOwner("Operator");
  // Rows with no directory: the policy reads an identity, it never changes one.
  const writer = seedIdentityRow({ actorId, name: "writer", metadata: { traits: ["writer"] } });
  (globalThis as Record<symbol, unknown>)[CLI_SCOPE] = { kind: "identity", name: writer.name, binding: { id: writer.id, home: directory } };
  const context = await withRunPolicy(async () => currentStoreContext()?.execution);
  expect(context?.allowedToolIds).toEqual(["bash:Bash"]);
  const reader = seedIdentityRow({ actorId, name: "reader", metadata: { traits: [] } });
  (globalThis as Record<symbol, unknown>)[CLI_SCOPE] = { kind: "identity", name: reader.name, binding: { id: reader.id, home: directory } };
  const effect = vi.fn(async () => "unsafe");
  await expect(withRunPolicy(effect)).rejects.toThrow("tool access denied");
  expect(effect).not.toHaveBeenCalled();
});

it("resolves a stored schedule bound and refuses raw execution before effects", async () => {
  await ensureFixtureTraits();
  const actorId = provisionOwner("Operator");
  const writer = seedIdentityRow({ actorId, name: "writer", metadata: { traits: ["writer"] } });
  await bounds.create({ name: "restricted-files", bound: { files: { allowOnly: [] } } });
  (globalThis as Record<symbol, unknown>)[CLI_SCOPE] = { kind: "identity", name: writer.name, binding: { id: writer.id, home: directory } };
  const schedule = normalizeSchedule("bounded", { every: "1h", action: "fixture:script", identity: writer.name, bounds: ["restricted-files"] }, directory, "fixture");
  const entry = { id: "fixture/bounded", bag: "fixture", name: "bounded", dir: directory, schedule };
  const policy = await scheduleContext(entry);
  const effect = vi.fn();
  await expect(withRunPolicy(async () => { await assertRawScriptPolicy(); effect(); }, policy)).rejects.toThrow("unbounded Bash grant");
  expect(effect).not.toHaveBeenCalled();
  await expect(scheduleContext({ ...entry, schedule: { ...schedule, bounds: ["missing"] } })).rejects.toThrow("unknown selected bound missing");
});

it("requires explicit traits for identity-free schedules and never synthesizes missing grants", async () => {
  const schedule = normalizeSchedule("maintenance", { every: "1h", action: "fixture:script" }, directory, "fixture");
  const entry = { id: "fixture/maintenance", bag: "fixture", name: "maintenance", dir: directory, schedule };
  await expect(scheduleContext(entry)).rejects.toThrow("must explicitly select traits");
  await expect(scheduleContext({ ...entry, schedule: { ...schedule, traits: ["bash"] } })).rejects.toThrow("unknown selected trait bash");
  await traits.ensure([{ name: "bash", namespaces: ["bash"], access: "read", bag: "bash" }], {});
  const readOnly = await scheduleContext({ ...entry, schedule: { ...schedule, traits: ["bash"] } });
  expect(readOnly.allowedToolIds).toEqual([]);
});
