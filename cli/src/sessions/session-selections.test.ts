import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { recallSelection, rememberSelection } from "./session-selections.js";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "barry-session-selections-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("round-trips independent identity and canonical harness selections atomically", () => {
  const directory = fixture(),
    key = { identityId: 3, harness: "claude-code" };
  expect(recallSelection(key, directory)).toEqual({ bags: [], bounds: [] });
  expect(
    rememberSelection(
      { ...key, bags: ["git", " bash ", "git", ""], bounds: ["readonly", " git:no-push "] },
      directory,
    ),
  ).toBe(true);
  rememberSelection({ identityId: 4, harness: "claude-code", bags: ["web"] }, directory);
  rememberSelection({ identityId: 3, harness: "codex", bags: ["coding"], bounds: ["readonly"] }, directory);
  expect(recallSelection(key, directory)).toEqual({
    bags: ["git", "bash"],
    bounds: ["readonly", "git:no-push"],
  });
  expect(recallSelection({ identityId: 4, harness: "claude-code" }, directory)).toEqual({
    bags: ["web"],
    bounds: [],
  });
  expect(recallSelection({ identityId: 3, harness: "codex" }, directory)).toEqual({
    bags: ["coding"],
    bounds: ["readonly"],
  });
  expect(statSync(join(directory, "session-selections.json")).mode & 0o777).toBe(0o600);
  const recalled = recallSelection(key, directory);
  recalled.bags.push("changed");
  recalled.bounds.push("changed");
  expect(recallSelection(key, directory)).toEqual({
    bags: ["git", "bash"],
    bounds: ["readonly", "git:no-push"],
  });
});

it("treats missing, corrupt, and invalid preferences as empty and preserves a nonempty selection", () => {
  const directory = fixture(),
    key = { identityId: 3, harness: "claude-code" };
  writeFileSync(join(directory, "session-selections.json"), "not-json");
  expect(recallSelection(key, directory)).toEqual({ bags: [], bounds: [] });
  rememberSelection({ ...key, bags: ["git"], bounds: ["readonly"] }, directory);
  rememberSelection({ ...key, bags: [], bounds: [] }, directory);
  expect(recallSelection(key, directory)).toEqual({ bags: ["git"], bounds: ["readonly"] });
  writeFileSync(
    join(directory, "session-selections.json"),
    JSON.stringify({ version: 2, selections: { '[3,"claude-code"]': { bags: [1] } } }),
  );
  expect(recallSelection(key, directory)).toEqual({ bags: [], bounds: [] });
});

it("isolates preferences by BARRY_HOME", () => {
  const key = { identityId: 3, harness: "claude-code" },
    one = fixture(),
    two = fixture();
  vi.stubEnv("BARRY_HOME", one);
  rememberSelection({ ...key, bags: ["git"], bounds: ["readonly"] });
  vi.stubEnv("BARRY_HOME", two);
  expect(recallSelection(key)).toEqual({ bags: [], bounds: [] });
  vi.stubEnv("BARRY_HOME", one);
  expect(recallSelection(key)).toEqual({ bags: ["git"], bounds: ["readonly"] });
});

it("does not overwrite another live writer's file or fail the launch", () => {
  const directory = fixture(),
    key = { identityId: 3, harness: "claude-code" };
  rememberSelection({ ...key, bags: ["git"] }, directory);
  const before = readFileSync(join(directory, "session-selections.json"), "utf8");
  writeFileSync(join(directory, "session-selections.lock"), String(process.pid));
  expect(rememberSelection({ ...key, bags: ["web"] }, directory)).toBe(false);
  expect(readFileSync(join(directory, "session-selections.json"), "utf8")).toBe(before);
});
