import { afterEach, expect, it, vi } from "vitest";
import { prune } from "./tools.js";

afterEach(() => vi.unstubAllEnvs());
it("refuses maintenance from a session context before opening any store", async () => {
  await expect(prune.handler({}, { sessionId: "caller", secrets: {} })).rejects.toThrow("installation maintenance");
});
it("also refuses session invocation identified through the environment", async () => {
  vi.stubEnv("BARRY_SESSION_ID", "caller");
  await expect(prune.handler({})).rejects.toThrow("installation maintenance");
});
