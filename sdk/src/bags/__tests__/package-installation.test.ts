import { mkdtempSync, writeFileSync, chmodSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { homebrewInventory, dpkgInventory, packageInstallation } from "../package-installation.js";
import { checkBagDependencyStates } from "../dependency-check.js";
import type { Bag } from "../types.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), "barry-package-probe-")); roots.push(root);
  const binary = join(root, "brew"); writeFileSync(binary, `#!/bin/sh\n${body}\n`); chmodSync(binary, 0o755);
  return { root, binary };
}
it("reads formula and cask inventory with argv and excludes unrelated credentials", () => {
  const { binary } = fixture('test -z "$SECRET_CANARY" || exit 1\ntest "$1" = list || exit 2\ncase "$2" in --formula) echo vendor/tap/tool;; --cask) echo desktop-app;; *) exit 3;; esac');
  expect(homebrewInventory(binary, { PATH: "/usr/bin:/bin", SECRET_CANARY: "private" })).toEqual(new Set(["vendor/tap/tool", "desktop-app"]));
});
it("reports failed and malformed inventory as unknown", () => {
  const failed = fixture("exit 1");
  const malformed = fixture('echo "unexpected diagnostic text"');
  expect(homebrewInventory(failed.binary, {})).toBeNull();
  expect(homebrewInventory(malformed.binary, {})).toBeNull();
});
it("separates an installed package from a missing executable on the service PATH", () => {
  const { root } = fixture('case "$2" in --formula) echo ripgrep;; --cask) echo desktop-app;; esac');
  const dependency = { package: "ripgrep", name: "nonexistent-barry-rg", reason: "Search", install: "brew install ripgrep" };
  const bag = { dependencies: [dependency] } as Bag;
  expect(checkBagDependencyStates(bag, "/empty-service-path", { PATH: root })[0]).toMatchObject({ state: "missing", packageInstallation: { state: "installed", manager: "homebrew" } });
  expect(packageInstallation({ ...dependency, package: "absent" }, { PATH: root })).toEqual({ state: "absent", manager: "homebrew" });
  expect(packageInstallation({ ...dependency, install: "apt install ripgrep" }, { PATH: root })).toEqual({ state: "unknown", manager: "dpkg" });
});

it("counts only fully installed Debian packages and preserves architecture aliases", () => {
  const { root, binary } = fixture("test -z \"$SECRET_CANARY\" || exit 1\ntest \"$1\" = --show || exit 2\nprintf 'libdemo:amd64\\tinstalled\\nremoved\\tconfig-files\\npartial\\tunpacked\\n'");
  const query = join(root, "dpkg-query"); renameSync(binary, query);
  expect(dpkgInventory(query, { SECRET_CANARY: "private" })).toEqual(new Set(["libdemo:amd64", "libdemo"]));
  const dependency = { package: "libdemo", name: "demo", install: "apt install libdemo" };
  expect(packageInstallation(dependency, { PATH: root })).toEqual({ state: "installed", manager: "dpkg" });
  expect(packageInstallation({ ...dependency, package: "removed" }, { PATH: root })).toEqual({ state: "absent", manager: "dpkg" });
});
it("does not infer absence from a failed Debian query", () => {
  const { binary } = fixture("exit 1");
  expect(dpkgInventory(binary, {})).toBeNull();
});
