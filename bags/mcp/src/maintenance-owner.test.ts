import { afterEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ maintenance: vi.fn(), start: vi.fn(async () => ({ close: async () => {} })) }));
vi.mock("@barry-rocks/sdk/internal/bags", async original => ({
  ...await original<typeof import("@barry-rocks/sdk/internal/bags")>(), startBagBuildMaintenance: calls.maintenance,
}));
vi.mock("./application.js", () => ({ startMcpApplication: calls.start }));
afterEach(() => vi.restoreAllMocks());
it("starts MCP without a competing shared bag-build maintenance worker", async () => {
  vi.spyOn(process, "on").mockImplementation(() => process);
  await import("./server-main.js");
  expect(calls.start).toHaveBeenCalledOnce();
  expect(calls.maintenance).not.toHaveBeenCalled();
}, 15_000);
