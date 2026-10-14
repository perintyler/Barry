import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePrivateFile } from "./private-file.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "private-config-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const permissions = (path: string) => lstatSync(path).mode & 0o777;

describe("private generated config files", () => {
  it("creates private parents and files with the complete contents", () => {
    const parent = join(root, "owned", "config");
    const path = join(parent, "secret.json");
    writePrivateFile(path, '{"token":"synthetic"}');
    expect(readFileSync(path, "utf8")).toBe('{"token":"synthetic"}');
    expect(permissions(parent)).toBe(0o700);
    expect(permissions(path)).toBe(0o600);
  });
  it("restores privacy on reused configs and replaces longer previous contents", () => {
    const path = join(root, "secret.json");
    writeFileSync(path, "obsolete longer config");
    chmodSync(path, 0o666);
    chmodSync(root, 0o777);
    writePrivateFile(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(permissions(root)).toBe(0o700);
    expect(permissions(path)).toBe(0o600);
  });
  it("does not follow a config symlink or overwrite its target", () => {
    const target = join(root, "unrelated");
    writeFileSync(target, "untouched");
    const path = join(root, "secret.json");
    symlinkSync(target, path);
    expect(() => writePrivateFile(path, "new")).toThrow(/regular file/);
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });
  it("refuses a symlinked immediate parent without changing its permissions", () => {
    const target = mkdtempSync(join(root, "unrelated-"));
    chmodSync(target, 0o755);
    const parent = join(root, "linked-parent");
    symlinkSync(target, parent);
    expect(() => writePrivateFile(join(parent, "secret.json"), "new")).toThrow(/owned directory/);
    expect(permissions(target)).toBe(0o755);
  });
});
