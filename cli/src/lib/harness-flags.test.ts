import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { addHarnessFlags, flaggedHarness, installedHarnesses } from "./harness-flags.js";

const previous = process.env.BARRY_HOME;
const home = mkdtempSync(join(tmpdir(), "barry-harness-flags-"));
let records: InstalledAdapter[];
beforeAll(async () => {
  process.env.BARRY_HOME = home;
  const store = loadAdapters({ file: barryAdaptersPath() });
  for (const folder of ["claude", "codex", "antigravity"]) await store.add(fileURLToPath(new URL(`../../../adapters/sessions/${folder}/`, import.meta.url)));
  records = await installedHarnesses();
  records.find(record => record.id === "codex")!.experimental = "Fixture";
  writeFileSync(barryAdaptersPath(), JSON.stringify(records));
});
afterAll(() => {
  if (previous === undefined) delete process.env.BARRY_HOME;
  else process.env.BARRY_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

function command(installed = records) {
  const command = new Command().exitOverride().option("--mode <mode>");
  addHarnessFlags(command, installed);
  return command;
}

describe("installed harness flags", () => {
  it.each(["--claude-code", "--claude", "--agy"])("selects %s from the record", flag => {
    const parsed = command().parse([flag], { from: "user" });
    expect(flaggedHarness(parsed.opts(), records)?.id).toBe(flag === "--agy" ? "antigravity" : "claude-code");
  });
  it("marks experimental adapters in help", () => {
    expect(command().helpInformation()).toContain("Use Codex (experimental)");
  });
  it("skips collisions without treating static option values as harness flags", () => {
    const colliding = [{ ...records[0], id: "mode", aliases: [] }];
    const parsed = command(colliding).parse(["--mode", "mode"], { from: "user" });
    expect(parsed.options.filter(option => option.long === "--mode")).toHaveLength(1);
    expect(flaggedHarness(parsed.opts(), colliding)).toBeUndefined();
  });
  it("refuses conflicting harness flags and accepts aliases of the same one", () => {
    expect(() => flaggedHarness(command().parse(["--claude", "--codex"], { from: "user" }).opts(), records)).toThrow("Conflicting harness flags");
    expect(flaggedHarness(command().parse(["--claude", "--claude-code"], { from: "user" }).opts(), records)?.id).toBe("claude-code");
  });
  it("keeps help and version available with unreadable records", async () => {
    writeFileSync(barryAdaptersPath(), "invalid json");
    const installed = await installedHarnesses();
    expect(installed).toEqual([]);
    const parsed = command(installed).version("test");
    expect(parsed.helpInformation()).toContain("--version");
    expect(parsed.helpInformation()).toContain("--help");
  });
});
