import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listCursorModels } from "./bin.js";

vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("child_process")>(),
  execFileSync: vi.fn(),
}));

const mocked = vi.mocked(execFileSync);
let barryHome: string;
beforeEach(() => {
  mocked.mockReset();
  barryHome = mkdtempSync(join(tmpdir(), "cursor-bin-"));
  vi.stubEnv("BARRY_HOME", barryHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(barryHome, { recursive: true, force: true });
});

describe("listCursorModels", () => {
  it("reads the ids out of --list-models output", () => {
    // Verbatim from `cursor agent --list-models`, cursor-agent 2026.09.10.
    mocked.mockReturnValue(
      [
        "Available models",
        "",
        "auto - Auto (default)",
        "composer-2.5 - Composer 2.5 (current)",
        "claude-opus-5-thinking-high - Claude Opus 5 1M Thinking",
        "",
      ].join("\n"),
    );
    expect(listCursorModels({ CURSOR_API_KEY: "selected-fixture-key" })).toEqual([
      "auto",
      "composer-2.5",
      "claude-opus-5-thinking-high",
    ]);
  });

  it("returns nothing when the list cannot be read", () => {
    // Callers must treat this as "unknown", not "no models exist" — the
    // difference decides whether every valid model gets warned about.
    mocked.mockImplementation((command, args) => {
      if (args?.includes("--list-models")) throw new Error("cursor: list unavailable");
      return "/fixture/cursor";
    });
    expect(listCursorModels({ CURSOR_API_KEY: "selected-fixture-key" })).toEqual([]);
  });
});

it("does not query through an ambient key or a user login without a selected credential", () => {
  vi.stubEnv("CURSOR_API_KEY", "ambient-provider-canary");
  expect(listCursorModels()).toEqual([]);
  expect(mocked).not.toHaveBeenCalled();
});
it("passes only the selected provider credential to model discovery", () => {
  vi.stubEnv("CURSOR_API_KEY", "ambient-provider-canary");
  vi.stubEnv("BARRY_SECRET", "ambient-instance-canary");
  mocked.mockImplementation((command) => command === "which" ? "/fixture/cursor" : "model-a - Model A");
  expect(listCursorModels({ CURSOR_API_KEY: "selected-provider-key", BARRY_SECRET: "selected-instance-key" })).toEqual(["model-a"]);
  const call = mocked.mock.calls.find(([, args]) => args?.includes("--list-models"))!;
  const options = call[2] as { env: Record<string, string> };
  expect(options.env.CURSOR_API_KEY).toBe("selected-provider-key");
  expect(options.env).not.toHaveProperty("BARRY_SECRET");
  // Never the user's home, where cursor would send their login and save the key's token over it.
  expect(options.env.HOME).toContain(join(barryHome, "cache", "cursor-homes"));
  expect(options.env.AGENT_CLI_CREDENTIAL_STORE).toBe("memory");
});
