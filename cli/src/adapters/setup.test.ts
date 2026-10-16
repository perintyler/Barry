import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
it("selects the shipped Claude adapter on a bundled runtime without requiring its PATH CLI and is idempotent", async () => {
  const adapters = store();
  expect(await selectShippedSessionAdapters(checkout, adapters, claude("2.1.0"))).toEqual(["claude-code", "pi"]);
  const first = adapters.installed();
  expect(first.map(record => record.id)).toEqual(["claude-code", "pi"]);
  expect(await selectShippedSessionAdapters(checkout, adapters, claude("2.1.0"))).toEqual([]);
  expect(adapters.installed()).toEqual(first);
});
it("accepts an untested build but does not select a missing binary", async () => {
  const adapters = store();
  expect(await selectShippedSessionAdapters(checkout, adapters, { ...claude("2.1.0"), which: () => null })).toEqual(["claude-code", "pi"]);
  const incompatible: HostProbes = { platform: "darwin", which: command => command === "codex" ? "/fixture/codex" : null, run: () => ({ stdout: "codex-cli 99.0.0", code: 0 }) };
  expect(await selectShippedSessionAdapters(checkout, adapters, incompatible)).toEqual(["codex"]);
});
it("preserves an explicit package selection even when it is no longer usable on this host", async () => {
  const adapters = store();
  await adapters.add(join(checkout, "adapters/sessions/claude"));
  const first = adapters.installed();
  await selectShippedSessionAdapters(checkout, adapters, { ...claude("99.0.0"), which: () => null });
  expect(adapters.installed().filter(record => record.id === "claude-code")).toEqual(first);
});

it("refreshes legacy shipped registrations in place and preserves idempotence", async () => {
  const adapters = store();
  await selectShippedSessionAdapters(checkout, adapters, claude("2.1.0"));
  const file = join(roots.at(-1)!, "adapters.json");
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  for (const record of legacy) {
    record.requirements.binary.pin = { version: record.requirements.binary.recommendedVersion, enforcedBy: "legacy fixture" };
    delete record.requirements.binary.recommendedVersion;
    delete record.requirements.binary.overrideEnv;
    for (const mode of Object.values(record.modes)) if (mode && typeof mode === "object") {
      Reflect.deleteProperty(mode, "versions"); Reflect.deleteProperty(mode, "build");
    }
  }
  writeFileSync(file, JSON.stringify(legacy));
  expect(await selectShippedSessionAdapters(checkout, adapters, claude("2.1.0"))).toEqual(["claude-code", "pi"]);
  expect(adapters.installed().every(record => record.modes.hosted?.build === "bundled")).toBe(true);
  expect(await selectShippedSessionAdapters(checkout, adapters, claude("2.1.0"))).toEqual([]);
});
