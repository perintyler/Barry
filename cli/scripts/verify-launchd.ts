import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { openInstance } from "@barry-rocks/sdk/internal/services";
import { ServiceManagement } from "@barry-rocks/mcp-bag";
import { launchd } from "@barry-rocks/mcp-bag";
const home = mkdtempSync(join(tmpdir(), "barry-launchd-verification-"));
const manager = new ServiceManagement(openInstance(home), [{ name: "fixture.worker", command: [process.execPath, "-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"], directory: home, domain: `gui/${process.getuid!()}`, plistDirectory: join(home, "plists"), logDirectory: join(home, "logs"), shutdownMs: 5000 }], launchd());
const wait = async () => {
  for (let count = 0; count < 50; count++) {
    const state = await manager.status("fixture.worker");
    if (state.pid) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("fixture process did not start");
};
try {
  await manager.apply("fixture.worker", "add");
  assert.equal((await manager.status("fixture.worker")).loaded, false);
  await manager.apply("fixture.worker", "enable");
  assert.equal((await manager.status("fixture.worker")).loaded, false);
  await manager.apply("fixture.worker", "disable");
  await manager.apply("fixture.worker", "start");
  const first = await wait(); assert.equal(first.enabled, false);
  await manager.apply("fixture.worker", "stop");
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await manager.status("fixture.worker")).loaded, false);
  await manager.apply("fixture.worker", "enable", { now: true });
  await wait();
  await manager.apply("fixture.worker", "disable");
  assert.ok((await manager.status("fixture.worker")).pid);
  await manager.apply("fixture.worker", "disable", { now: true });
  assert.equal((await manager.status("fixture.worker")).loaded, false);
  await manager.apply("fixture.worker", "remove");
  assert.equal((await manager.status("fixture.worker")).registered, false);
  console.log("Isolated launchd lifecycle passed: inert registration, policy-only enable/disable, manual start while disabled, stop without restart, and removal.");
} finally {
  try { await manager.apply("fixture.worker", "remove"); } finally { rmSync(home, { recursive: true, force: true }); }
}
