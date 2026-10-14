/** Dedicated provisioned macOS runner only. Never run privileged acceptance on a personal host. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkLinks } from "../src/releases/build.js";
import { readRelease } from "../src/releases/release.js";
import { assertRootProtected, codeDigest } from "../src/services/system.js";
import { SystemCleanupLease } from "../src/releases/health-ownership.js";

const [tarballArg, outputArg] = process.argv.slice(2);
assert.ok(tarballArg && outputArg, "usage: verify-release-health.ts <actual-tarball> <new-output>");
assert.equal(process.env.BARRY_RELEASE_SYSTEM_ENABLED, "true", "privileged release acceptance requires explicit dedicated-runner enablement");
assert.equal(process.platform, "darwin"); assert.equal(process.arch, "arm64");
const uid = process.getuid!(); assert.ok(uid > 0, "run producer as the instance owner, never root");
const tarball = resolve(tarballArg), root = resolve(outputArg); mkdirSync(root, { mode: 0o700 });
const home = join(root, "home"), instance = join(root, "instance"), support = join(instance, "app-support"); mkdirSync(home);
const env = { HOME: home, BARRY_HOME: instance, PATH: `${join(instance, "bin") }:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: root, LOG_LEVEL: "silent" };
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const report: Record<string, unknown> = { schema: 1, sourceSha: process.env.GITHUB_SHA, tarballSha256: digest(tarball), runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, passed: false, completed: false, healthCertified: false, cleanupPassed: false, requiredServices: [], services: [], systemProtection: [], commands: [] };
const save = () => writeFileSync(join(root, "release-health.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
save();
function command(file: string, args: string[], expected = 0) {
  const result = spawnSync(file, args, { env, cwd: root, encoding: "utf8", timeout: 300000, maxBuffer: 16 * 1024 ** 2 });
  (report.commands as unknown[]).push({ command: [file, ...args], status: result.status, stdout: result.stdout, stderr: result.stderr }); save();
  assert.equal(result.status, expected, `${file} ${args.join(" ")}: ${result.error?.message ?? result.stderr}`); return result.stdout;
}
let binary: string | undefined, instanceId: string | undefined;
let systemLease: SystemCleanupLease | undefined;
let definitions: Array<{ name: string; domain: string; user?: string; command: string[]; directory: string; plistDirectory: string }> = [];
const systemPaths: string[] = [];
const sudo = (args: string[]) => command("/usr/bin/sudo", ["-n", "/usr/bin/env", `HOME=${home}`, `BARRY_HOME=${instance}`, `TMPDIR=${root}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", ...args]);
const guard = () => {
  assert.ok(instanceId && /^[a-f0-9-]{36}$/.test(instanceId), "unknown owned instance");
  const owned = JSON.parse(readFileSync(join(support, "instance.json"), "utf8")) as { id: string; uid: number };
  assert.equal(owned.id, instanceId); assert.equal(owned.uid, uid, "instance owner changed");
  assert.equal(realpathSync(instance), join(realpathSync(root), "instance"));
};
try {
  assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/); assert.match(process.env.GITHUB_RUN_ID ?? "", /^\d+$/); assert.match(process.env.GITHUB_RUN_ATTEMPT ?? "", /^\d+$/);
  command("/usr/bin/sudo", ["-n", "/usr/bin/true"]);
  assert.equal(readFileSync(`${tarball}.sha256`, "utf8").trim().split(/\s+/)[0], report.tarballSha256, "published artifact digest mismatch");
  const listing = command("/usr/bin/tar", ["-tzf", tarball]).trim().split("\n");
  assert.ok(listing.every(path => !path.startsWith("/") && !path.split("/").includes("..")), "unsafe archive path");
  assert.equal(new Set(listing.map(path => path.split("/")[0])).size, 1);
  const extracted = join(root, "artifact"); mkdirSync(extracted); command("/usr/bin/tar", ["-xzf", tarball, "-C", extracted]);
  const entries = readdirSync(extracted); assert.equal(entries.length, 1); const releaseRoot = join(extracted, entries[0]); checkLinks(releaseRoot);
  const release = readRelease(releaseRoot); assert.ok(release); assert.equal(release.commit, report.sourceSha, "release source differs from this run");
  binary = join(releaseRoot, "bin/barry");
  command(binary, ["setup", "--no-start"]);
  const identity = JSON.parse(readFileSync(join(support, "instance.json"), "utf8")) as { id: string }; instanceId = identity.id; guard();
  definitions = JSON.parse(readFileSync(join(support, "managed-definitions.json"), "utf8")) as typeof definitions;
  const system = definitions.filter(definition => definition.domain === "system" || definition.user);
  assert.ok(system.length, "artifact declares no system services");
  const specs = JSON.parse(readFileSync(join(support, "service-definitions.json"), "utf8")) as Record<string, { bag: string; entry?: string; health?: string }>;
  for (const definition of system) {
    assert.match(definition.name, /^[a-z0-9][a-z0-9._-]+$/i); assert.ok(definition.user);
    const accountGid = Number(command("/usr/bin/id", ["-g", definition.user]).trim());
    assert.ok(process.getgroups!().includes(accountGid), `${definition.user} account and active owner membership must be preprovisioned; no shared account/group mutation is permitted`);
    const legacy = `com.barry.bag.${definition.name}`;
    assert.ok(!existsSync(join("/Library/LaunchDaemons", `${legacy}.plist`)), "preexisting legacy daemon would be mutated");
    const observed = spawnSync("/usr/bin/sudo", ["-n", "/bin/launchctl", "print", `system/${legacy}`], { encoding: "utf8", timeout: 5000 });
    assert.ok(observed.status !== 0 && /Could not find service|not found/i.test(observed.stderr), "legacy daemon presence could not be excluded");
    assertRootProtected("/usr/local/libexec"); assertRootProtected("/usr/local/var");
    assert.match(specs[definition.name].bag, /^[a-z0-9][a-z0-9._-]*$/i);
    systemPaths.push(`/usr/local/var/barry-${specs[definition.name].bag}-${instanceId}`);
  }
  systemPaths.push(join("/usr/local/libexec/barry", instanceId));
  systemLease = new SystemCleanupLease(systemPaths);
  report.requiredServices = definitions.map(definition => ({ name: definition.name, system: definition.domain === "system" || Boolean(definition.user), hasHealth: Boolean(specs[definition.name].health) })); save();
  guard(); systemLease.start(() => { sudo([binary!, "setup", "--system"]); });
  for (const definition of system) { guard(); sudo([binary, "service", "enable", definition.name, "--now"]); }
  for (const definition of definitions.filter(definition => !system.includes(definition))) command(binary, ["service", "enable", definition.name, "--now"]);
  let statuses: { services: Array<Record<string, unknown>> } | undefined;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const result = spawnSync(binary, ["service", "status", "all", "--json"], { env, encoding: "utf8", timeout: 10000 });
    try {
      const observed = JSON.parse(result.stdout) as { services: Array<Record<string, unknown>> };
      if (result.status === 0 && definitions.every(definition => observed.services.some(service => service.key === definition.name && service.registered === true && service.enabled === true && service.state === "running" && Number(service.pid) > 0 && (!specs[definition.name].health || service.health === "ok")))) { statuses = observed; break; }
    } catch { /* A service may still be starting. */ }
    await delay(500);
  }
  assert.ok(statuses, "all declared services must become enabled, running and healthy within 90 seconds");
  report.services = statuses.services.map(service => ({ ...service, name: service.key }));
  const doctor = JSON.parse(command(binary, ["doctor", "--json", "--strict"])) as unknown; report.doctor = doctor; report.strictDoctorExit = 0;
  report.systemProtection = system.map(definition => {
    assertRootProtected(definition.directory); assertRootProtected(definition.command[0]);
    const entry = specs[definition.name].entry; assert.ok(entry);
    assert.ok(realpathSync(entry).startsWith(realpathSync(join(support, "current")) + "/"), "system entry must belong to the installed artifact");
    const codeSha256 = codeDigest(definition.directory), runtimeSha256 = digest(definition.command[0]);
    assert.equal(codeSha256, codeDigest(dirname(entry)), "system code differs from the installed artifact");
    assert.equal(runtimeSha256, digest(join(releaseRoot, "runtime/bin/node")), "system runtime differs from the shipped runtime");
    return { name: definition.name, codeProtected: true, runtimeProtected: true, matchesArtifact: true, codeSha256, runtimeSha256 };
  });
  report.passed = true;
} catch (error) { report.failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  try {
    if (binary && existsSync(join(support, "instance.json"))) {
      if (!instanceId) instanceId = (JSON.parse(readFileSync(join(support, "instance.json"), "utf8")) as { id: string }).id;
      guard();
      command(binary, ["setup", "--uninstall", ...(systemLease?.started ? [] : ["--purge"]), "--yes"]);
      systemLease?.cleanup(() => { if (existsSync(join(support, "instance.json"))) { guard(); sudo([binary!, "setup", "--uninstall", "--system", "--purge", "--yes"]); } });
      for (const definition of definitions) {
        const label = `rocks.barry.${instanceId}.${definition.name}`;
        assert.ok(!existsSync(join(definition.plistDirectory, `${label}.plist`)), `${label} plist remains`);
        if (!systemLease?.started && (definition.domain === "system" || definition.user)) continue;
        const result = spawnSync("/usr/bin/sudo", ["-n", "/bin/launchctl", "print", `${definition.domain}/${label}`], { encoding: "utf8", timeout: 5000 });
        assert.ok(result.status !== 0 && /Could not find service|not found/i.test(result.stderr), `${label} registration remains or cannot be inspected`);
      }
      if (systemLease?.started) assert.ok(systemPaths.every(path => !existsSync(path)), "fixture system paths remain");
      assert.ok(!existsSync(support), "fixture installation remains");
    }
    report.cleanupPassed = true;
  } catch (error) { report.cleanupFailure = error instanceof Error ? error.message : String(error); report.passed = false; process.exitCode = 1; }
  report.completed = true; report.healthCertified = report.passed === true && report.cleanupPassed === true; save();
  if (report.healthCertified) {
    const validation = spawnSync(process.execPath, [resolve(".github/ci/validate-release-health.mjs"), join(root, "release-health.json"), tarball], { env: { ...env, GITHUB_SHA: process.env.GITHUB_SHA, GITHUB_RUN_ID: process.env.GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT }, encoding: "utf8", timeout: 10000 });
    if (validation.status !== 0) { report.validationFailure = validation.stderr; report.passed = false; report.healthCertified = false; process.exitCode = 1; save(); }
  }
  console.log(`Privileged health receipt: ${join(root, "release-health.json")}`);
  if (report.failure || report.cleanupFailure) console.error(report.failure ?? report.cleanupFailure);
}
