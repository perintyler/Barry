import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI_TARGET } from "./target.js";
import { withRunBounds, assertRawScriptBounds } from "./resource-target.js";
import { currentStoreContext } from "@barry-rocks/sdk/internal/stores";
import { Barry } from "@barry-rocks/sdk";
import { identities } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore } from "@barry-rocks/identities-bag/testing";
import { provisionOwner, seedIdentityRow } from "../test/helpers/identities.js";
import { resolveScheduleAccess } from "@barry-rocks/schedules-bag";
import { normalizeSchedule } from "@barry-rocks/sdk/internal/schedules";
import { closeInstallationRegistry } from "@barry-rocks/sdk/internal/nodes";

vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>()),
  loadBags: async () => [{ name: "bash", tools: [{ name: "Bash", namespace: "bash", access: "write" }] }] as never,
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "barry-cli-script-bounds-"));
  closeIdentitiesStore();
  vi.stubEnv("BARRY_HOME", directory);
  vi.stubEnv("BARRY_IDENTITIES_DB", join(directory, "identities.db"));
  Barry.use(identities);
});

afterEach(() => {
  Barry.reset();
  closeInstallationRegistry();
  closeIdentitiesStore();
  delete (globalThis as Record<symbol, unknown>)[CLI_TARGET];
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("resolves real stored identity bags and bounds and refuses a stored read-only Bash bound", async () => {
  const actorId = provisionOwner("Operator");
  const writer = seedIdentityRow({
    actorId,
    name: "writer",
    metadata: { bags: ["bash"], bounds: [] },
  });
  (globalThis as Record<symbol, unknown>)[CLI_TARGET] = {
    kind: "identity",
    name: writer.name,
    binding: { id: writer.id, home: directory },
  };
  const context = await withRunBounds(async () => currentStoreContext()?.execution);
  expect(context?.allowedToolIds).toEqual(["bash:Bash"]);

  const reader = seedIdentityRow({
    actorId,
    name: "reader",
    metadata: { bags: ["bash"], bounds: ["readonly"] },
  });
  (globalThis as Record<symbol, unknown>)[CLI_TARGET] = {
    kind: "identity",
    name: reader.name,
    binding: { id: reader.id, home: directory },
  };
  const effect = vi.fn(async () => "unsafe");
  await expect(withRunBounds(effect)).rejects.toThrow("tool access denied");
  expect(effect).not.toHaveBeenCalled();
});

it("resolves a stored schedule bound and refuses raw execution before effects", async () => {
  const actorId = provisionOwner("Operator");
  const writer = seedIdentityRow({
    actorId,
    name: "writer",
    metadata: {
      bags: ["bash"],
      bounds: [
        {
          "restricted-files": {
            description: "Restricted files",
            optional: true,
            files: { allow: [] },
          },
        },
      ],
    },
  });
  (globalThis as Record<symbol, unknown>)[CLI_TARGET] = {
    kind: "identity",
    name: writer.name,
    binding: { id: writer.id, home: directory },
  };
  const schedule = normalizeSchedule(
    "bounded",
    { every: "1h", action: "fixture:script", identity: writer.name, bounds: ["restricted-files"] },
    directory,
    "fixture",
  );
  const entry = { id: "fixture/bounded", bag: "fixture", name: "bounded", dir: directory, schedule };
  const callerBounds = await resolveScheduleAccess(entry);
  const effect = vi.fn();
  await expect(
    withRunBounds(async () => {
      await assertRawScriptBounds();
      effect();
    }, callerBounds),
  ).rejects.toThrow("unbounded Bash tool from the caller's bounds");
  expect(effect).not.toHaveBeenCalled();
  await expect(
    resolveScheduleAccess({ ...entry, schedule: { ...schedule, bounds: ["missing"] } }),
  ).rejects.toThrow(/unknown.*bound.*missing/i);
});

it("requires explicit bags for identity-free schedules and never synthesizes missing bags", async () => {
  const schedule = normalizeSchedule("maintenance", { every: "1h", action: "fixture:script" }, directory, "fixture");
  const entry = { id: "fixture/maintenance", bag: "fixture", name: "maintenance", dir: directory, schedule };
  await expect(resolveScheduleAccess(entry)).rejects.toThrow("must explicitly select bags");
  const readOnly = await resolveScheduleAccess({
    ...entry,
    schedule: { ...schedule, bags: ["bash:read"] },
  });
  expect(readOnly.allowedToolIds).toEqual([]);
});
