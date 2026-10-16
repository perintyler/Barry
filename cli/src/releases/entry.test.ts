import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error The executable bootstrap intentionally runs without a TS loader.
import { checkoutCommit, selectEntry } from "../../bin/entry.js";
const roots: string[] = [];
function fixture(commit = "a".repeat(40)) {
  const root = mkdtempSync(join(tmpdir(), "barry-entry-")); roots.push(root);
  mkdirSync(join(root, "cli/dist"), { recursive: true });
  writeFileSync(join(root, "cli/dist/barry.js"), "");
  writeFileSync(join(root, "cli/dist/build.json"), JSON.stringify({ commit, inputs: {} }));
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("selects matching checkout and release bundles, and honors the source override", () => {
  const root = fixture(); expect(selectEntry(root, "barry", {})).toMatchObject({ entry: "bundle" });
  mkdirSync(join(root, ".git/refs/heads"), { recursive: true });
  writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git/refs/heads/main"), "a".repeat(40));
  expect(selectEntry(root, "barry", {})).toMatchObject({ entry: "bundle" });
  expect(selectEntry(root, "barry", { BARRY_BUNDLE: "0" })).toEqual({ entry: "tsx" });
  writeFileSync(join(root, ".git/refs/heads/main"), "b".repeat(40));
  expect(selectEntry(root, "barry", {})).toEqual({ entry: "tsx", stale: true });
});
it("resolves linked worktree common refs and detached heads", () => {
  const root = fixture(); mkdirSync(join(root, "common/worktrees/test"), { recursive: true });
  writeFileSync(join(root, ".git"), "gitdir: common/worktrees/test\n");
  writeFileSync(join(root, "common/worktrees/test/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, "common/worktrees/test/commondir"), "../..\n");
  writeFileSync(join(root, "common/packed-refs"), `${"a".repeat(40)} refs/heads/main\n`);
  expect(checkoutCommit(root)).toBe("a".repeat(40));
  writeFileSync(join(root, "common/worktrees/test/HEAD"), "b".repeat(40));
  expect(checkoutCommit(root)).toBe("b".repeat(40));
});
it("uses freshly built dirty sources but falls back after an edit at the same HEAD", () => {
  const root = fixture();
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git/HEAD"), "a".repeat(40));
  const file = join(root, "source.ts");
  writeFileSync(file, "dirty source at build time");
  const stamp = statSync(file);
  writeFileSync(join(root, "cli/dist/build.json"), JSON.stringify({ commit: "a".repeat(40), dirty: true, inputs: { "source.ts": `${stamp.mtimeMs}:${stamp.ctimeMs}:${stamp.size}` } }));
  expect(selectEntry(root, "barry", {})).toMatchObject({ entry: "bundle" });
  writeFileSync(file, "edited after the build");
  expect(selectEntry(root, "barry", {})).toEqual({ entry: "tsx", stale: true });
});
