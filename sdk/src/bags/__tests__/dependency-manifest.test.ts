import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseManifestObject } from "../manifest.js";
import { checkBagDependencies } from "../bag-dependencies.js";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const root = mkdtempSync(join(tmpdir(), "barry-dependency-file-")); directories.push(root); return root; }
function parse(dependencies: unknown, root = "/bags/demo") {
  return parseManifestObject({ name: "demo", description: "Demo", dependencies }, "test", root).dependencies;
}
it("normalizes package keys, binary aliases, optional dependencies and platform hints", () => {
  const declarations = parse({ ripgrep: { bin: "rg", reason: "Search", install: { macos: "brew install ripgrep", linux: "apt install ripgrep" } }, sqlite3: { reason: "Optional diagnostics", optional: true } });
  expect(declarations[0]).toMatchObject({ package: "ripgrep", name: "rg", reason: "Search" });
  if (process.platform === "darwin") expect(declarations[0].install).toBe("brew install ripgrep");
  if (process.platform === "linux") expect(declarations[0].install).toBe("apt install ripgrep");
  expect(declarations[1]).toMatchObject({ name: "sqlite3", optional: true });
});
it("loads the same dependency map from an owned YAML file", () => {
  const root = directory();
  writeFileSync(join(root, "dependencies.yaml"), "ripgrep:\n  bin: rg\n  reason: Search\n");
  expect(parse("dependencies.yaml", root)).toEqual(parse({ ripgrep: { bin: "rg", reason: "Search" } }));
});
it("parses only static Brewfile statements with comments", () => {
  const root = directory();
  writeFileSync(join(root, "Brewfile"), '# Tools\nbrew "ripgrep" # Search\ncask \'ollama\'\n');
  const dependencies = parse("Brewfile", root);
  expect(dependencies.map(item => item.package)).toEqual(["ripgrep", "ollama"]);
  if (process.platform === "darwin") expect(dependencies.map(item => item.install)).toEqual(["brew install ripgrep", "brew install --cask ollama"]);
});
it("refuses Ruby expressions without executing them", () => {
  const root = directory();
  const marker = join(root, "executed");
  writeFileSync(join(root, "Brewfile"), `File.write(${JSON.stringify(marker)}, "executed")`);
  expect(() => parse("Brewfile", root)).toThrow("only static brew or cask");
  expect(existsSync(marker)).toBe(false);
});
it.each(['brew "rg", link: true', 'brew "rg"\nbrew "rg"', 'tap "user/tap"', 'brew "rg\''])('rejects unsupported Brewfile statement %s', text => {
  const root = directory(); writeFileSync(join(root, "Brewfile"), text);
  expect(() => parse("Brewfile", root)).toThrow();
});
it("rejects external file paths including symlink escapes", () => {
  const root = directory(); const bag = join(root, "bag"); mkdirSync(bag);
  writeFileSync(join(root, "external.yaml"), "tool:\n  reason: External\n");
  symlinkSync(join(root, "external.yaml"), join(bag, "dependencies.yaml"));
  for (const path of ["../external.yaml", join(root, "external.yaml"), "dependencies.yaml"]) {
    expect(() => parse(path, bag)).toThrow();
  }
});
it.each([[{ name: "rg", reason: "Legacy" }], { rg: { reason: "Search", install: "brew install rg" } }, { rg: { bin: "rg" } }])("rejects retired or incomplete dependency declarations %j", source => {
  expect(() => parse(source)).toThrow();
});
it("excludes missing optional binaries from required dependency failures", () => {
  expect(checkBagDependencies([{ name: "demo", dependencies: parse({ nonexistent_barrry_binary: { reason: "Diagnostics", optional: true } }) }])).toEqual([]);
});

it("requires an executable alias for qualified package keys and derives it for static Brewfile formulas", () => {
  expect(() => parse({ "vendor/tap/tool": { reason: "Qualified package" } })).toThrow();
  expect(parse({ "vendor/tap/tool": { bin: "tool", reason: "Qualified package" } })[0]).toMatchObject({ package: "vendor/tap/tool", name: "tool" });
  const root = directory();
  writeFileSync(join(root, "Brewfile"), 'brew "vendor/tap/tool"\n');
  expect(parse("Brewfile", root)[0]).toMatchObject({ package: "vendor/tap/tool", name: "tool" });
});
