import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReleaseHealth } from "./validate-release-health.mjs";
const expected = { sourceSha: "a".repeat(40), tarballSha256: "b".repeat(64), runId: "123", runAttempt: "2" };
function fixture() {
  return { schema: 1, ...expected, completed: true, passed: true, cleanupPassed: true, healthCertified: true, strictDoctorExit: 0,
    requiredServices: [{ name: "vault.api", system: true, hasHealth: true }], services: [{ name: "vault.api", registered: true, enabled: true, pid: 123, state: "running", health: "ok" }],
    systemProtection: [{ name: "vault.api", codeProtected: true, runtimeProtected: true, matchesArtifact: true, codeSha256: "c".repeat(64), runtimeSha256: "d".repeat(64) }],
    doctor: { installation: ["current", "shim", "path", "node", "services", "bounds", "owner", "nodes"].map(name => ({ name, status: "pass" })) } };
}
test("accepts complete same-run actual artifact health evidence", () => assert.equal(validateReleaseHealth(fixture(), expected).passed, true));
test("rejects different source, bytes, run or attempt", () => {
  for (const key of Object.keys(expected)) { const receipt = fixture(); receipt[key] = "other"; assert.throws(() => validateReleaseHealth(receipt, expected), /mismatch/); }
});
test("rejects absent workflow context and unclassified service evidence", () => {
  assert.throws(() => validateReleaseHealth(fixture(), {}));
  const receipt = fixture(); delete receipt.requiredServices[0].hasHealth; assert.throws(() => validateReleaseHealth(receipt, expected));
  const missing = fixture(); missing.requiredServices = []; assert.throws(() => validateReleaseHealth(missing, expected));
});
test("rejects missing cleanup, incomplete receipts and disabled or unhealthy services", () => {
  for (const key of ["completed", "passed", "cleanupPassed", "healthCertified"]) { const receipt = fixture(); receipt[key] = false; assert.throws(() => validateReleaseHealth(receipt, expected)); }
  for (const patch of [{ enabled: false }, { registered: false }, { pid: 0 }, { health: "failing" }, { state: "stopped" }]) { const receipt = fixture(); Object.assign(receipt.services[0], patch); assert.throws(() => validateReleaseHealth(receipt, expected)); }
});
test("rejects unprotected system execution and incomplete doctor evidence", () => {
  for (const field of ["codeProtected", "runtimeProtected", "matchesArtifact"]) { const receipt = fixture(); receipt.systemProtection[0][field] = false; assert.throws(() => validateReleaseHealth(receipt, expected)); }
  const receipt = fixture(); receipt.doctor.installation.pop(); assert.throws(() => validateReleaseHealth(receipt, expected));
  const failed = fixture(); failed.strictDoctorExit = 1; assert.throws(() => validateReleaseHealth(failed, expected));
});
