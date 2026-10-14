import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Barry } from "@barry-rocks/sdk";
import { fakeSessions } from "@barry-rocks/sdk/testing";
vi.mock("@barry-rocks/sdk/stores", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/stores")>(),
  sessionIdentity: vi.fn(() => "identity"),
}));
import { ActionRuns, closeDb } from "@barry-rocks/actions-bag";
import { actionShowCommand, actionRunsCommand } from "./action.js";

beforeEach(() => {
  vi.stubEnv("BARRY_ACTIONS_DB", join(mkdtempSync(join(tmpdir(), "barry-action-cli-")), "actions.db"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  Barry.use(fakeSessions({ get: async () => ({ endedAt: "2026-10-01T00:00:00Z" }) as never }));
});
afterEach(() => {
  closeDb();
  Barry.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("sweeps before action show prints the recorded run", async () => {
  const run = await ActionRuns.create({ action: "audit", bag: "test", session_id: "s1" });
  await actionShowCommand(run.id, { json: true });
  expect(JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))).toMatchObject({ status: "failed", summary: expect.stringContaining("Abandoned") });
});

it("sweeps before action runs applies its status filter", async () => {
  await ActionRuns.create({ action: "audit", bag: "test", session_id: "s1" });
  await actionRunsCommand({ status: "started", json: true });
  expect(vi.mocked(console.log).mock.calls[0][0]).toBe("[]");
});
