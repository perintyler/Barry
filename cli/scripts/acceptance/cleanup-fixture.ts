/** Remove only jobs recorded by the acceptance driver before its first OS mutation. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Instance } from "@barry-rocks/sdk/internal/services";
import { ServiceManagement, type ServiceDefinition } from "@barry-rocks/mcp-bag";
import { launchd } from "@barry-rocks/mcp-bag";
const raw = process.argv[2];
if (process.platform !== "darwin" || !raw?.startsWith("/")) throw new Error("requires an absolute owned macOS acceptance root");
const root = resolve(raw);
const receipt = JSON.parse(readFileSync(join(root, "cleanup.json"), "utf8")) as {
  root: string; instance: Instance; definitions: ServiceDefinition[]; legacy?: Array<{ domain: string; label: string; plist: string }>;
};
assert.equal(receipt.root, root);
assert.ok(receipt.instance.home.startsWith(root + "/"));
assert.equal(JSON.parse(readFileSync(join(receipt.instance.home, "instance.json"), "utf8")).id, receipt.instance.id);
assert.ok(receipt.definitions.every(definition => definition.name.startsWith("fixture.") && definition.logDirectory.startsWith(root + "/")));
assert.ok(receipt.definitions.every(definition => definition.domain === `gui/${process.getuid!()}` || (definition.domain === "system" && process.getuid?.() === 0)));
const os = launchd(), manager = new ServiceManagement(receipt.instance, receipt.definitions, os);
for (const job of receipt.legacy ?? []) {
  assert.ok(job.label === `com.barry.acceptance.${receipt.instance.id}.legacy` || job.label === `com.barry.bag.acceptance-${receipt.instance.id}.app.Legacy`);
  assert.ok(job.plist === join("/Library/LaunchDaemons", job.label + ".plist") || job.plist.startsWith(root + "/"));
}
for (const definition of receipt.definitions) {
  await manager.apply(definition.name, "remove"); assert.equal((await manager.status(definition.name)).loaded, false);
}
for (const job of receipt.legacy ?? []) {
  os.enable(job.domain, job.label, false); await os.unload(job.domain, job.label, 5000);
  assert.equal(os.inspect(job.domain, job.label).loaded, false);
}
writeFileSync(join(root, "cleanup-result.json"), JSON.stringify({ cleaned: true, at: new Date().toISOString(), registrationCount: receipt.definitions.length + (receipt.legacy?.length ?? 0), retainedRecoveryBytes: (receipt.legacy ?? []).filter(job => existsSync(job.plist)).length }), { mode: 0o600 });
console.log("PASS owned acceptance jobs unloaded and disabled; recovery bytes retained");
