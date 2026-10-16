import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Barry, BarryError, type Bound, type Identities, type Tool } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import { normalizeSchedule } from "@barry-rocks/sdk/internal/schedules";

vi.mock("@barry-rocks/sdk/internal/nodes", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/nodes")>(),
  installationRegistry: () => ({ identityId: (id: number) => `stable-${id}` }),
}));

const { resolveScheduleAccess } = await import("./permissions.js");

const STATUS_TOOL: Tool = { name: "status", namespace: "git", bag: "git", access: "read" };
const NO_FILES_BOUND: Bound = { files: { allow: [] } };

const bound = vi.fn<NonNullable<Identities["bound"]>>(async (_ref, selectedBounds) => {
  if (selectedBounds?.includes("missing")) {
    throw new BarryError("invalid", "unknown bound missing");
  }
  return selectedBounds?.includes("no-files") ? NO_FILES_BOUND : null;
});

const tools = vi.fn<NonNullable<Identities["tools"]>>(async (_ref, selection) => {
  if (Array.isArray(selection.bounds) && selection.bounds.includes("missing")) {
    throw new BarryError("invalid", "unknown bound missing");
  }
  return [STATUS_TOOL];
});

const get = vi.fn<Identities["get"]>(async (ref) => {
  if (ref !== "bux") throw new BarryError("not_found", `Identity "${String(ref)}" not found`);
  return { id: 4, name: "bux" } as Awaited<ReturnType<Identities["get"]>>;
});

beforeEach(() => {
  bound.mockClear();
  tools.mockClear();
  get.mockClear();
  Barry.use(fakeIdentities({ bound, tools, get }));
});
afterEach(() => Barry.reset());

function entry(raw: { identity?: string; bags?: string[]; bounds?: string[] }) {
  return {
    id: "fixture/nightly",
    bag: "fixture",
    name: "nightly",
    dir: ".",
    schedule: normalizeSchedule("nightly", { every: "1h", action: "fixture:script", ...raw }, ".", "fixture"),
  };
}

it("runs as the identity it names, with what it selects on top and never the installation's defaults", async () => {
  const access = await resolveScheduleAccess(
    entry({ identity: "bux", bags: ["git"], bounds: ["no-files"] }),
    "claude",
  );
  expect(bound).toHaveBeenCalledWith("bux", ["no-files"], { kind: "owner" });
  expect(tools).toHaveBeenCalledWith("bux", { bags: ["git"], bounds: ["no-files"] }, { kind: "owner" });
  expect(access).toEqual({
    identity: "stable-4",
    bags: ["git"],
    bound: { files: { allow: [] } },
    tools: [STATUS_TOOL],
    allowedToolIds: ["git:status"],
    harness: "claude",
  });
});

it("grants an identity-free schedule only the bags it selects", async () => {
  await resolveScheduleAccess(entry({ bags: ["git"] }));
  expect(bound).toHaveBeenCalledWith(null, [], { kind: "owner" });
  expect(tools).toHaveBeenCalledWith(null, { bags: ["git"], bounds: [] }, { kind: "owner" });
  await expect(resolveScheduleAccess(entry({}))).rejects.toThrow("an identity-free schedule must explicitly select bags");
});

it("refuses an identity or a bound that does not exist", async () => {
  await expect(resolveScheduleAccess(entry({ identity: "nobody", bags: ["git"] }))).rejects.toThrow(
    'unknown schedule identity: Identity "nobody" not found',
  );
  expect(bound).not.toHaveBeenCalled();
  await expect(resolveScheduleAccess(entry({ identity: "bux", bounds: ["missing"] }))).rejects.toThrow(
    "invalid schedule permissions: unknown bound missing",
  );
});
