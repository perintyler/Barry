import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifestObject } from "../manifest.js";

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const manifest = { name: "documents", description: "Documents" };
function directory() { const dir = mkdtempSync(join(tmpdir(), "tool-discovery-")); directories.push(dir); return dir; }
describe("conventional tools", () => {
  it("prefers tools.ts over src/tools.ts and preserves authored visibility", () => {
    const dir = directory(); mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/tools.ts"), ""); writeFileSync(join(dir, "tools.ts"), "");
    const parsed = parseManifestObject({ ...manifest, tools: [{ read: "deferred" }] }, "fixture", dir);
    expect(parsed.toolsEntry?.entry).toBe("tools.ts");
    expect(parsed.toolVisibility).toEqual({ read: "deferred" });
  });
  it("uses src/tools.ts when there is no root entry", () => {
    const dir = directory(); mkdirSync(join(dir, "src")); writeFileSync(join(dir, "src/tools.ts"), "");
    expect(parseManifestObject(manifest, "fixture", dir).toolsEntry?.entry).toBe("src/tools.ts");
  });
  it("rejects overrides without a conventional entry", () => {
    expect(() => parseManifestObject({ ...manifest, tools: [{ read: "enabled" }] }, "fixture", directory())).toThrow(/require tools.ts/);
  });
});

it("rejects inline local metadata while permitting explicit remote MCP protocol metadata", () => {
  const raw = { ...manifest, tools: [{ toolName: "read", namespace: "documents", access: "read" }] };
  expect(() => parseManifestObject(raw)).toThrow("local tool metadata belongs in Barry.Tool code");
  expect(() => parseManifestObject(raw, "local", directory())).toThrow("local tool metadata belongs in Barry.Tool code");
  expect(parseManifestObject(raw, "remote", "", { source: "remote" }).tools).toEqual(raw.tools);
});
