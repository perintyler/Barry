import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Barry, BarryError, type Grants, type Identities } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import { normalizeSchedule } from "@barry-rocks/sdk/internal/schedules";

vi.mock("@barry-rocks/sdk/internal/nodes", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/nodes")>(),
  installationRegistry: () => ({ identityId: (id: number) => `stable-${id}` }),
}));

const { scheduleContext } = await import("./permissions.js");

const granted: Grants = {
  traits: ["git"], bound: { files: { allowOnly: [] } }, namespaces: ["git"],
  tools: [{ name: "status", namespace: "git", bag: "git", access: "read" }], skills: [], instructions: [],
};
const grants = vi.fn<Identities["grants"]>(async (_ref, selection) => {
  if (selection.bounds?.includes("missing")) throw new BarryError("invalid", "unknown bound missing");
  return granted;
});
const get = vi.fn<Identities["get"]>(async (ref) => {
  if (ref !== "bux") throw new BarryError("not_found", `Identity "${String(ref)}" not found`);
  return { id: 4, name: "bux" } as Awaited<ReturnType<Identities["get"]>>;
});
beforeEach(() => {
  grants.mockClear();
  Barry.use(fakeIdentities({ grants, get }));
});
afterEach(() => Barry.reset());

function entry(raw: { identity?: string; traits?: string[]; bounds?: string[] }) {
  return { id: "fixture/nightly", bag: "fixture", name: "nightly", dir: ".", schedule: normalizeSchedule("nightly", { every: "1h", action: "fixture:script", ...raw }, ".", "fixture") };
}

it("runs as the identity it names, with what it selects on top and never the installation's defaults", async () => {
  const context = await scheduleContext(entry({ identity: "bux", traits: ["git"], bounds: ["no-files"] }), "claude");
  expect(grants).toHaveBeenCalledWith("bux", { traits: ["git"], harness: "claude", bounds: ["no-files"], defaults: false }, { kind: "owner" });
  expect(context).toEqual({ identity: "stable-4", traits: ["git"], bound: { files: { allowOnly: [] } }, allowedToolIds: ["git:status"], harness: "claude" });
});

it("grants an identity-free schedule only the traits it selects", async () => {
  await scheduleContext(entry({ traits: ["git"] }));
  expect(grants).toHaveBeenCalledWith(null, { traits: ["git"], bounds: [], defaults: false }, { kind: "owner" });
  await expect(scheduleContext(entry({}))).rejects.toThrow("must explicitly select traits");
});

it("refuses an identity or a bound that does not exist", async () => {
  await expect(scheduleContext(entry({ identity: "nobody", traits: ["git"] }))).rejects.toThrow('unknown schedule identity: Identity "nobody" not found');
  expect(grants).not.toHaveBeenCalled();
  await expect(scheduleContext(entry({ identity: "bux", bounds: ["missing"] }))).rejects.toThrow("invalid schedule permissions: unknown bound missing");
});
