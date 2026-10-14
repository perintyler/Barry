import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barryVersion, readRelease, versionAt } from "./release.js";

const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "barry-version-")); roots.push(root); return root; };
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repository() {
  const root = fixture();
  const home = join(root, "home"); mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.name=Release Test", "-c", "user.email=release@example.test", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  const commit = () => { git("add", "file"); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  writeFileSync(join(root, "file"), "one");
  return { root, git, commit, head: commit() };
}
for (const annotated of [false, true]) it(`uses ${annotated ? "annotated" : "lightweight"} release tags`, () => {
  const repo = repository();
  repo.git("tag", ...(annotated ? ["-a", "-m", "release"] : []), "v0.10.0-beta.1");
  expect(versionAt(repo.root, repo.head)).toBe("0.10.0-beta.1");
  expect(barryVersion(repo.root)).toBe("0.10.0-beta.1-dev");
  writeFileSync(join(repo.root, "file"), "two");
  expect(barryVersion(repo.root)).toBe("0.10.0-beta.1-dirty-dev");
  const head = repo.commit();
  expect(versionAt(repo.root, head)).toBe(`0.10.0-beta.1-1-g${head.slice(0, 12)}`);
});
it("ignores v0.1 and describes commits without release tags", () => {
  const repo = repository();
  expect(versionAt(repo.root, repo.head)).toBe(`0.0.0-g${repo.head.slice(0, 12)}`);
  repo.git("tag", "v0.1");
  expect(versionAt(repo.root, repo.head)).toBe(`0.0.0-g${repo.head.slice(0, 12)}`);
  writeFileSync(join(repo.root, "file"), "dirty");
  expect(barryVersion(repo.root)).toBe(`0.0.0-g${repo.head.slice(0, 12)}-dirty-dev`);
});
for (const annotated of [false, true]) it(`uses the explicit ${annotated ? "annotated" : "lightweight"} tag when multiple versions share a commit`, () => {
  const repo = repository();
  repo.git("tag", "v0.0.0-pr57-test");
  repo.git("tag", ...(annotated ? ["-a", "-m", "release"] : []), "v1.2.3");
  expect(versionAt(repo.root, repo.head, "v1.2.3")).toBe("1.2.3");
  expect(versionAt(repo.root, repo.head, "refs/tags/v1.2.3")).toBe("1.2.3");
  expect(versionAt(repo.root, repo.head, "refs/tags/v0.0.0-pr57-test")).toBe("0.0.0-pr57-test");
  expect(() => versionAt(repo.root, repo.head, "v9.9.9")).toThrow("does not resolve");
  writeFileSync(join(repo.root, "file"), "two");
  expect(() => versionAt(repo.root, repo.commit(), "refs/tags/v1.2.3")).toThrow("does not resolve");
});
it("uses a development fallback outside git", () => { expect(barryVersion(fixture())).toBe("0.0.0-dev"); });
it("reads release metadata, prefers it to git, and rejects malformed files", () => {
  const root = fixture();
  expect(readRelease(root)).toBeUndefined();
  const release = { version: "0.10.0-beta.1", commit: "a".repeat(40), platform: "darwin-arm64", node: { version: "26.11.1", sha256: "b".repeat(64) }, stores: { "core/config": 3 }, built: "2026-10-08T00:00:00.000Z" };
  writeFileSync(join(root, "release.json"), JSON.stringify(release));
  expect(readRelease(root)).toEqual(release);
  expect(barryVersion(root)).toBe(release.version);
  writeFileSync(join(root, "release.json"), "{}");
  expect(() => readRelease(root)).toThrow();
  writeFileSync(join(root, "release.json"), "{");
  expect(() => readRelease(root)).toThrow();
});

it("reads the committed version without git and gives release metadata precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-version-"));
  try {
    mkdirSync(join(root, "cli"));
    writeFileSync(join(root, "cli/version.json"), JSON.stringify({ version: "1.2.3-dev" }));
    expect(barryVersion(root)).toBe("1.2.3-dev");
    writeFileSync(join(root, "release.json"), JSON.stringify({ version: "1.2.3", commit: "a".repeat(40), platform: "darwin-arm64", node: { version: "26.11.1", sha256: "1".repeat(64) }, stores: {}, built: "2026-10-08T00:00:00.000Z" }));
    expect(barryVersion(root)).toBe("1.2.3");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
