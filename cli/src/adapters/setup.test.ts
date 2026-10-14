import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import type { HostProbes } from "@barry-rocks/sdk/adapters/models";
import { selectShippedSessionAdapters } from "./setup.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function store() {
  const root = mkdtempSync(join(tmpdir(), "barry-session-selection-")); roots.push(root);
  return loadAdapters({ file: join(root, "adapters.json") });
}
const checkout = fileURLToPath(new URL("../../../", import.meta.url));
function claude(version: string): HostProbes {
  return { platform: "darwin", which: command => command === "claude" ? "/fixture/claude" : null, run: () => ({ stdout: `${version} (Claude Code)`, code: 0 }) };
}
it("selects the shipped Claude adapter on a compatible host and is idempotent", async () => {
  const adapters = store();
  expect(await selectShippedSessionAdapters(checkout, adapters, claude("2.1.0"))).toEqual(["claude-code"]);
  const first = adapters.installed();
  expect(first.map(record => record.id)).toEqual(["claude-code"]);
  expect(await selectShippedSessionAdapters(checkout, adapters, claude("2.1.0"))).toEqual([]);
  expect(adapters.installed()).toEqual(first);
});
it("does not select a missing binary or a different verified major", async () => {
  const adapters = store();
  expect(await selectShippedSessionAdapters(checkout, adapters, { ...claude("2.1.0"), which: () => null })).toEqual([]);
  const incompatible: HostProbes = { platform: "darwin", which: command => command === "codex" ? "/fixture/codex" : null, run: () => ({ stdout: "codex-cli 99.0.0", code: 0 }) };
  expect(await selectShippedSessionAdapters(checkout, adapters, incompatible)).toEqual([]);
  expect(adapters.installed()).toEqual([]);
});
it("preserves an explicit package selection even when it is no longer usable on this host", async () => {
  const adapters = store();
  await adapters.add(join(checkout, "adapters/sessions/claude"));
  const first = adapters.installed();
  await selectShippedSessionAdapters(checkout, adapters, { ...claude("99.0.0"), which: () => null });
  expect(adapters.installed()).toEqual(first);
});
