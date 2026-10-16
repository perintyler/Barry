import { afterEach, expect, it, vi } from "vitest";
import { ensureBagsBuilt } from "@barry-rocks/sdk/internal/bags";
import { createLogger } from "@barry-rocks/sdk/logging";
import { loadBagTools } from "./bag-loading.js";

vi.mock("@barry-rocks/sdk/internal/bags", async importOriginal => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  ensureBagsBuilt: vi.fn(async () => []),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("loads without a stale-build scan unless the rollback switch is explicit", async () => {
  const snapshot = { registry: {}, bags: [], byName: new Map() };
  vi.stubEnv("BARRY_BAGS_REBUILD", "");
  vi.stubEnv("BARRY_BAGS_BUILT", "1");
  await loadBagTools(snapshot, createLogger("test"), new Map());
  expect(ensureBagsBuilt).not.toHaveBeenCalled();
  vi.stubEnv("BARRY_BAGS_REBUILD", "1");
  await loadBagTools(snapshot, createLogger("test"), new Map());
  expect(ensureBagsBuilt).toHaveBeenCalledOnce();
});
