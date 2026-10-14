import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMergedSettings } from "./settings.js";

describe("resolved native settings", () => {
  it("writes the exact resolved denials and refreshes the same file", () => {
    const directory = mkdtempSync(join(tmpdir(), "settings-test-"));
    try {
      const path = join(directory, "settings.json");
      buildMergedSettings({ path, deniedTools: ["Bash", "Read"] });
      expect(JSON.parse(readFileSync(path, "utf8")).permissions.deny).toEqual(["Bash(*)", "Read(*)"]);
      buildMergedSettings({ path, deniedTools: [] });
      expect(JSON.parse(readFileSync(path, "utf8")).permissions.deny).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
