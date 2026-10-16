import { afterEach, expect, it, vi } from "vitest";
import { currentStoreContext, withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { CLI_TARGET } from "./target.js";
const { authorize, getSession } = vi.hoisted(() => ({ authorize: vi.fn(), getSession: vi.fn(async (_id: string): Promise<{ identity_id: number } | undefined> => undefined) }));
vi.mock("./tool-bounds.js", () => ({ authorizeIdentityTool: authorize }));
vi.mock("@barry-rocks/sessions-bag/client", () => ({
  Sessions: { get: getSession },
}));
import {
  assertOwnedActionRun,
  assertOwnedSchedule,
  filterOwnedRuns,
  runOwnerMetadata,
  withRunBounds,
  assertRawScriptBounds,
} from "./resource-target.js";
const state = globalThis as Record<symbol, unknown>;
afterEach(() => {
  delete state[CLI_TARGET];
  vi.clearAllMocks();
});
it("binds action output to a stable identity across a rename and hides foreign or unknown owners", async () => {
  state[CLI_TARGET] = {
    kind: "identity",
    name: "renamed",
    binding: { id: 42, home: "/fixture" },
  };
  const own = { session_id: null, metadata: { identity_id: 42 } };
  const foreign = { session_id: null, metadata: { identity_id: 7 } };
  const unknown = { session_id: "missing", metadata: {} };
  expect(runOwnerMetadata()).toEqual({ identity_id: 42 });
  expect(await filterOwnedRuns([own, foreign, unknown])).toEqual([own]);
  await expect(assertOwnedActionRun(foreign)).rejects.toThrow(
    "does not belong",
  );
  await expect(assertOwnedActionRun(unknown)).rejects.toThrow(
    "does not belong",
  );
  getSession.mockResolvedValueOnce({ identity_id: 42 });
  await expect(
    assertOwnedActionRun({ session_id: "owned", metadata: {} }),
  ).resolves.toBeUndefined();
});
it("rejects foreign and unowned schedule mutations before they reach the store", () => {
  state[CLI_TARGET] = {
    kind: "identity",
    name: "bonanza",
    binding: { id: 42, home: "/fixture" },
  };
  expect(() => assertOwnedSchedule("bonanza")).not.toThrow();
  expect(() => assertOwnedSchedule("foreign")).toThrow("does not belong");
  expect(() => assertOwnedSchedule(undefined)).toThrow("does not belong");
});

it("resolves an identity's Bash grant before dispatch and preserves the caller ceiling", async () => {
  state[CLI_TARGET] = { kind: "identity", name: "selected", binding: { id: 42, home: "/fixture" } };
  authorize.mockResolvedValue({ identity: "uuid-42", bags: ["bash"], bounds: [], bound: null, allowedToolIds: ["bash:Bash"], node: "local", bagConfigurations: {} });
  const observed = await withRunBounds(async () => currentStoreContext()?.execution);
  expect(authorize).toHaveBeenCalledWith({ namespace: "bash", name: "Bash", access: "write" });
  expect(observed?.allowedToolIds).toEqual(["bash:Bash"]);
  const restricted = await withStoreContext({ execution: { bags: [], bounds: [], bound: { files: { allow: [] } }, allowedToolIds: [] } },
    () => withRunBounds(async () => currentStoreContext()?.execution));
  expect(restricted?.allowedToolIds).toEqual([]);
  expect(restricted?.bound?.files?.allow).toEqual([]);
});
it("does not dispatch after identity authorization fails", async () => {
  state[CLI_TARGET] = { kind: "identity", name: "selected", binding: { id: 42, home: "/fixture" } };
  authorize.mockRejectedValue(new Error("tool access denied"));
  const effect = vi.fn(async () => "unsafe");
  await expect(withRunBounds(effect)).rejects.toThrow("tool access denied");
  expect(effect).not.toHaveBeenCalled();
});
it("keeps administrative launches separate from identity selection", async () => {
  expect(await withRunBounds(async () => "admin")).toBe("admin");
  expect(authorize).not.toHaveBeenCalled();
});

it("rejects bounded raw children before effects, including administrative caller ceilings", async () => {
  const effect = vi.fn();
  for (const execution of [
    { bags: [], bounds: [], bound: null, allowedToolIds: [] },
    { bags: ["bash"], bounds: [], bound: { files: { allow: [] } }, allowedToolIds: ["bash:Bash"] },
  ]) {
    await expect(withStoreContext({ execution }, async () => {
      await assertRawScriptBounds();
      effect();
    })).rejects.toThrow("unbounded Bash tool from the caller's bounds");
  }
  expect(effect).not.toHaveBeenCalled();
  await expect(withStoreContext({ execution: { bags: ["bash"], bounds: [], bound: null, allowedToolIds: ["bash:Bash"] } }, assertRawScriptBounds)).resolves.toBeUndefined();
});

it("keeps selected schedule bounds and tool grants as ceilings for system and identity launches", async () => {
  const selected = { bags: ["schedule"], bounds: [], bound: { files: { allow: [] } }, allowedToolIds: [] };
  expect(await withRunBounds(async () => currentStoreContext()?.execution, selected)).toEqual(selected);
  state[CLI_TARGET] = { kind: "identity", name: "selected", binding: { id: 42, home: "/fixture" } };
  authorize.mockResolvedValue({ identity: "uuid-42", bags: ["bash"], bounds: [], bound: null, allowedToolIds: ["bash:Bash"] });
  const observed = await withRunBounds(async () => currentStoreContext()?.execution, selected);
  expect(observed?.allowedToolIds).toEqual([]);
  expect(observed?.bound?.files?.allow).toEqual([]);
  await expect(withRunBounds(async () => "unsafe", { ...selected, identity: "foreign" })).rejects.toThrow("schedule identity does not match");
});
