import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeServiceRegistry } from "@barry-rocks/sdk/services";
import { appListCommand, appUrlCommand } from "./app.js";

afterEach(() => vi.unstubAllEnvs());

function setupRegistry() {
  const home = mkdtempSync(join(tmpdir(), "barry-app-test-"));
  vi.stubEnv("BARRY_HOME", home);
  writeServiceRegistry({
    version: 2,
    generated: new Date().toISOString(),
    resources: {
      "sessions.macos": {
        bag: "sessions",
        name: "macos",
        kind: "app",
        id: "barry-sessions",
        displayName: "Barry Sessions",
        protocolVersion: 1,
        capabilities: { streaming: true, gating: true, listener: true, attachments: true },
        urlSchemes: ["barry", "barry-sessions"],
      },
    },
  });
}

describe("barry app commands", () => {
  it("outputs registered apps as json", async () => {
    setupRegistry();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await appListCommand({ json: true });
    expect(logSpy).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output).toHaveLength(1);
    expect(output[0].id).toBe("barry-sessions");
    expect(output[0].protocolVersion).toBe(1);
    logSpy.mockRestore();
  });

  it("prints app url and deep-links with session params", async () => {
    setupRegistry();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await appUrlCommand("barry-sessions");
    expect(logSpy).toHaveBeenCalledWith("barry://");

    await appUrlCommand("barry-sessions", { session: "sess-abc" });
    expect(logSpy).toHaveBeenCalledWith("barry://sess-abc");
    logSpy.mockRestore();
  });
});
