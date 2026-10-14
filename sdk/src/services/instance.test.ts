import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openInstance } from "./instance.js";

const home = () => mkdtempSync(join(tmpdir(), "barry-instance-"));

describe("openInstance", () => {
  it("creates a record once and returns the same id afterwards", () => {
    const dir = home();
    const first = openInstance(dir);
    expect(openInstance(dir).id).toBe(first.id);
  });

  it.each([
    ["empty", ""],
    ["truncated", '{"id":"abc'],
    ["missing id", "{}"],
  ])("refuses a %s record instead of minting a new id", (_label, contents) => {
    const dir = home();
    writeFileSync(join(dir, "instance.json"), contents);
    expect(() => openInstance(dir)).toThrow(/is unreadable; restore it from a backup/);
    expect(readFileSync(join(dir, "instance.json"), "utf8")).toBe(contents);
  });
});
