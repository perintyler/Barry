/** GUI process lifecycle through direct launchd ownership, independent of the engine. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openInstance } from "@barry-rocks/sdk/internal/services";
import { ServiceManagement } from "@barry-rocks/mcp-bag";
import { launchd } from "@barry-rocks/mcp-bag";
const raw = process.argv[2];
if (process.platform !== "darwin" || !raw?.startsWith("/")) throw new Error("requires macOS GUI session and an absolute new fixture root");
const root = resolve(raw); if (existsSync(root)) throw new Error("root must not already exist");
mkdirSync(root, { mode: 0o700 });
const executable = join(root, "Fixture.app", "Contents", "MacOS", "Fixture"), events = join(root, "events.log");
mkdirSync(join(executable, ".."), { recursive: true });
execFileSync("/usr/bin/swiftc", [fileURLToPath(new URL("./fixtures/app.swift", import.meta.url)), "-o", executable], { stdio: "pipe" });
const instance = openInstance(join(root, "app-support")), os = launchd();
const manager = new ServiceManagement(instance, [{ name: "fixture.app", command: [executable, events], directory: root,
  domain: `gui/${process.getuid!()}`, plistDirectory: join(root, "plists"), logDirectory: join(root, "logs"), shutdownMs: 5000 }], os);
const ready = async (old?: number) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await manager.status("fixture.app");
    if (state.pid && state.pid !== old && existsSync(events) && readFileSync(events, "utf8").includes(`ready ${state.pid}`)) return state.pid;
    await delay(100);
  }
  throw new Error("AppKit app failed readiness");
};
const results: string[] = [];
writeFileSync(join(root, "cleanup.json"), JSON.stringify({ root, instance, definitions: [manager.definition("fixture.app")] }), { mode: 0o600 });
try {
  await manager.apply("fixture.app", "add");
  await manager.apply("fixture.app", "start"); const first = await ready();
  assert.ok(readFileSync(events, "utf8").includes(`ready ${first}`));
  await manager.apply("fixture.app", "restart"); const second = await ready(first);
  assert.ok(readFileSync(events, "utf8").includes(`terminated ${first}`));
  await manager.apply("fixture.app", "stop"); assert.equal((await manager.status("fixture.app")).loaded, false);
  assert.ok(readFileSync(events, "utf8").includes(`terminated ${second}`));
  results.push("real AppKit app starts, restarts and gracefully terminates under direct GUI-domain ownership");
  console.log("PASS " + results[0]);
} finally {
  await manager.apply("fixture.app", "remove");
  writeFileSync(join(root, "acceptance.json"), JSON.stringify({ instance: instance.id, root, results, cleaned: true }, null, 2), { mode: 0o600 });
}
