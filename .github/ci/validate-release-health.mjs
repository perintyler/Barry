import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function validateReleaseHealth(receipt, expected) {
  assert.match(expected.sourceSha, /^[a-f0-9]{40}$/, "missing canonical workflow source SHA");
  assert.match(expected.tarballSha256, /^[a-f0-9]{64}$/, "missing artifact digest");
  assert.match(expected.runId, /^[1-9]\d*$/, "missing workflow run ID");
  assert.match(expected.runAttempt, /^[1-9]\d*$/, "missing workflow run attempt");
  assert.equal(receipt.schema, 1, "unknown health receipt schema");
  for (const key of ["sourceSha", "tarballSha256", "runId", "runAttempt"]) assert.equal(receipt[key], expected[key], `health receipt ${key} mismatch`);
  for (const key of ["completed", "passed", "cleanupPassed", "healthCertified"]) assert.equal(receipt[key], true, `health receipt ${key} is uncertified`);
  assert.equal(receipt.strictDoctorExit, 0, "strict doctor did not pass");
  assert.ok(Array.isArray(receipt.requiredServices) && receipt.requiredServices.length > 0, "missing declared service inventory");
  assert.equal(new Set(receipt.requiredServices.map(service => service.name)).size, receipt.requiredServices.length, "duplicate declared service");
  assert.ok(receipt.requiredServices.some(service => service.system), "no system service certified");
  for (const required of receipt.requiredServices) {
    assert.equal(typeof required.system, "boolean", "missing service domain classification");
    assert.equal(typeof required.hasHealth, "boolean", "missing declared health classification");
    const observed = receipt.services.find(service => service.name === required.name);
    assert.ok(observed?.registered && observed.enabled && Number.isSafeInteger(observed.pid) && observed.pid > 0 && observed.state === "running", `${required.name} is not enabled and running`);
    if (required.hasHealth) assert.equal(observed.health, "ok", `${required.name} is unhealthy`);
    if (required.system) {
      assert.equal(required.hasHealth, true, "system service lacks declared health endpoint");
      const proof = receipt.systemProtection.find(service => service.name === required.name);
      assert.ok(proof?.codeProtected && proof.runtimeProtected && proof.matchesArtifact && /^[a-f0-9]{64}$/.test(proof.codeSha256) && /^[a-f0-9]{64}$/.test(proof.runtimeSha256), `${required.name} lacks protected execution proof`);
    }
  }
  const checks = receipt.doctor?.installation;
  assert.ok(Array.isArray(checks) && ["current", "shim", "path", "node", "services", "bounds", "owner", "nodes"].every(name => checks.some(check => check.name === name && check.status === "pass")), "incomplete doctor evidence");
  assert.ok(checks.every(check => check.status === "pass"), "doctor contains failures or skipped checks");
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [receiptPath, tarball] = process.argv.slice(2);
  validateReleaseHealth(JSON.parse(readFileSync(receiptPath, "utf8")), {
    sourceSha: process.env.GITHUB_SHA, tarballSha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"),
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  console.log("Same-run release artifact privileged health evidence verified.");
}
