import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bagBuildExternals } from "../build-configuration.js";
import { parseManifestObject } from "../manifest.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), "barry-build-config-")); roots.push(root); return root; }
it("reads package-owned build settings freshly and defaults to no extra externals", () => {
  const root = directory();
  expect(bagBuildExternals(root)).toEqual([]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", barry: { build: { externals: ["sharp", "@scope/native", "sharp"] } } }));
  expect(bagBuildExternals(root)).toEqual(["sharp", "@scope/native"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  expect(bagBuildExternals(root)).toEqual([]);
});
it.each(["not-json-private-canary", JSON.stringify({ barry: { build: { externals: ["../private-canary"] } } }), JSON.stringify({ barry: { build: { externals: "private-canary" } } })])("fails invalid metadata without exposing contents", contents => {
  const root = directory(); writeFileSync(join(root, "package.json"), contents);
  expect(() => bagBuildExternals(root)).toThrow("expected package names");
  try { bagBuildExternals(root); } catch (error) { expect(String(error)).not.toContain("private-canary"); }
});
it("rejects the retired manifest external setting with its replacement", () => {
  expect(() => parseManifestObject({ name: "fixture", description: "Fixture", tools: { entry: "tools.ts", externals: ["sharp"] } })).toThrow("package.json barry.build.externals");
});
