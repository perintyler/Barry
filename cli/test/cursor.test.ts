import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { writeServiceRegistry } from "@barry-rocks/sdk/services";
import { join } from "path";
import { namesToPrune } from "../src/lib/cursor-mcp.js";
import { runWithEnv } from "./run-cli.js";
import { generateCursorIdeConfig } from "../src/mcp-config.js";

describe("namesToPrune", () => {
  it("prunes previous managed names that are no longer generated", () => {
    expect(
      namesToPrune(["barry", "linear", "user-custom"], ["barry"], ["barry", "linear"]),
    ).toEqual(["linear"]);
  });

  // With no record of what Barry wrote last time, nothing is known to be
  // Barry's, so nothing is pruned. This used to fall back to a hardcoded list
  // of pre-overhaul names, which could delete a hand-written entry that merely
  // shared a name with one Barry once managed.
  it("prunes nothing when the managed manifest is missing", () => {
    expect(
      namesToPrune(["barry", "linear", "figma", "my-own"], ["barry"], []),
    ).toEqual([]);
  });

  it("never prunes names still in the next managed set", () => {
    expect(namesToPrune(["barry"], ["barry"], [])).toEqual([]);
  });
});

describe("generateCursorIdeConfig", () => {
  it("emits a single HTTP barry entry with env-interpolated auth", () => {
    // The engine's address comes from the instance registry.
    process.env.BARRY_HOME = mkdtempSync(join(tmpdir(), "barry-cursor-"));
    writeServiceRegistry({
      version: 2,
      generated: new Date().toISOString(),
      resources: { "mcp.server": { bag: "mcp", name: "server", kind: "service", url: "http://127.0.0.1:4901" } },
    });
    const config = generateCursorIdeConfig();
    expect(Object.keys(config.mcpServers)).toEqual(["barry"]);
    const barry = config.mcpServers.barry;
    expect(barry.type).toBe("http");
    expect(barry.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(barry.headers?.Authorization).toBe("Bearer ${env:BARRY_SECRET}");
  });
});

it("requires an explicitly selected Cursor adapter before configuring a user's IDE", () => {
  const home = mkdtempSync(join(tmpdir(), "barry-unselected-cursor-"));
  try {
    const result = runWithEnv({ BARRY_HOME: home, HOME: home }, "cursor", "setup");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("adapter not installed: cursor");
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
