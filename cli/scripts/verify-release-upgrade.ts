/** Real release artifacts only: isolated install → candidate → rollback, with retained evidence. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { checkLinks } from "../src/releases/build.js";
import { readRelease, type Release } from "../src/releases/release.js";
import { receiptSchema } from "../src/releases/receipts.js";

const fixtureTable = "release_verification_fixture";
const logicalNormalization = "node/identities/identities.db traits.metadata null harnessTraits/nativeTools equals absent (the trait reader omits both); all other stores and values are compared exactly";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, (_key, entry: unknown) => typeof entry === "bigint" ? entry.toString() : entry instanceof Uint8Array ? Buffer.from(entry).toString("base64") : entry);
interface StoreEvidence { fileSha256: string; tables: Record<string, { rows: number; sha256: string; rawSha256: string }>; fixtureRows: number; fixtureSha256: string }
export function captureStores(directory: string, seed = false, snapshotDirectory?: string): Record<string, StoreEvidence> {
  const evidence: Record<string, StoreEvidence> = {};
  const walk = (folder: string, relative = "") => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const key = join(relative, entry.name), path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path, key);
      else if (entry.isFile() && entry.name.endsWith(".db")) {
        const db = new DatabaseSync(path, { readOnly: !seed });
        try {
          if (seed) {
            db.exec(`CREATE TABLE IF NOT EXISTS ${fixtureTable}(id INTEGER PRIMARY KEY,payload TEXT NOT NULL)`);
            const insert = db.prepare(`INSERT OR IGNORE INTO ${fixtureTable} VALUES(?,?)`);
            db.exec("BEGIN IMMEDIATE");
            try { for (let id = 0; id < 16; id++) insert.run(id, `${key}:${id}:${"x".repeat(1024)}`); db.exec("COMMIT"); }
            catch (error) { db.exec("ROLLBACK"); throw error; }
          }
          assert.equal(db.prepare("PRAGMA quick_check").get()?.quick_check, "ok", `${key} integrity`);
          assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0, `${key} foreign keys`);
          const tables: StoreEvidence["tables"] = {};
          for (const table of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
            const name = String(table.name), quoted = `"${name.replaceAll('"', '""')}"`;
            const query = db.prepare(`SELECT * FROM ${quoted}`); query.setReadBigInts(true);
            const rawRows = query.all();
            const rawSha256 = hash(rawRows.map(row => json(row)).sort().join("\n"));
            const rows = rawRows.map(row => {
              // An upgrade's builtin trait sync may remove explicit nulls;
              // bags/identities/src/config/traits.ts reads null and absent as the same no-value.
              // Preserve every non-null value and every other metadata key.
              if (key === join("node", "identities", "identities.db") && name === "traits" && typeof row.metadata === "string") {
                const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
                for (const key of ["harnessTraits", "nativeTools"]) if (metadata[key] === null) delete metadata[key];
                row = { ...row, metadata: JSON.stringify(metadata) };
              }
              return json(row);
            }).sort(); tables[name] = { rows: rows.length, sha256: hash(rows.join("\n")), rawSha256 };
          }
          assert.ok(tables[fixtureTable], `${key}: missing retained fixture`);
          if (snapshotDirectory) {
            const snapshot = join(snapshotDirectory, key); mkdirSync(dirname(snapshot), { recursive: true, mode: 0o700 });
            db.prepare("VACUUM INTO ?").run(snapshot);
          }
          evidence[key] = { fileSha256: "", tables, fixtureRows: tables[fixtureTable].rows, fixtureSha256: tables[fixtureTable].sha256 };
        } finally { db.close(); }
        evidence[key].fileSha256 = hash(readFileSync(path));
      }
    }
  };
  walk(directory); assert.ok(Object.keys(evidence).length, "no store databases found"); return evidence;
}
export function compareStores(before: Record<string, StoreEvidence>, after: Record<string, StoreEvidence>, unchangedCatalog: boolean): void {
  for (const [path, original] of Object.entries(before)) {
    const current = after[path]; assert.ok(current, `store disappeared: ${path}`);
    assert.equal(current.fixtureRows, original.fixtureRows, `${path}: fixture row count changed`);
    assert.equal(current.fixtureSha256, original.fixtureSha256, `${path}: fixture data changed`);
    if (unchangedCatalog) {
      const logical = (tables: StoreEvidence["tables"]) => Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, { rows: table.rows, sha256: table.sha256 }]));
      assert.deepEqual(logical(current.tables), logical(original.tables), `${path}: logical data changed under an unchanged migration catalog`);
    }
    else for (const [name, table] of Object.entries(original.tables)) {
      assert.ok(current.tables[name], `${path}: retained table disappeared after migration: ${name}`);
      assert.ok(current.tables[name].rows >= table.rows, `${path}: retained table lost rows after migration: ${name}`);
    }
  }
}
function execute(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 120000) {
  const result = spawnSync(program, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 32 * 1024 ** 2 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message };
}
export function isExpectedSystemDrift(detail: string, expectedSystem: string[], serviceFailures: Array<{ name: string; detail: string }> = []): boolean {
  const drift = /^unprepared: (.*); unregistered: (.*)$/.exec(detail);
  if (!drift) return serviceFailures.length > 0 && serviceFailures.every(check => expectedSystem.includes(check.name)) &&
    detail === serviceFailures.map(check => `${check.name.slice(8)}: ${check.detail}`).join("; ");
  const names = [...drift[1].split(","), ...drift[2].split(",")].map(name => name.trim()).filter(Boolean);
  return names.length > 0 && names.every(name => expectedSystem.includes(`service:${name}`));
}
function unpack(tarball: string, target: string, requireSidecar = false): { root: string; release: Release; tarballSha256: string } {
  assert.ok(statSync(tarball).isFile(), `missing tarball ${tarball}`);
  if (requireSidecar) assert.ok(existsSync(`${tarball}.sha256`), "historical release requires its published SHA-256 sidecar");
  mkdirSync(target, { mode: 0o700 });
  const cleanEnv = { PATH: "/usr/bin:/bin", HOME: target };
  const listing = execute("/usr/bin/tar", ["-tzf", tarball], target, cleanEnv);
  assert.equal(listing.status, 0, listing.stderr);
  const names = listing.stdout.trim().split("\n");
  assert.ok(names.every(name => !name.startsWith("/") && !name.split("/").includes("..")), "unsafe archive member");
  assert.equal(new Set(names.map(name => name.split("/")[0])).size, 1, "archive must have one top-level directory");
  const extracted = execute("/usr/bin/tar", ["-xzf", tarball, "-C", target], target, cleanEnv);
  assert.equal(extracted.status, 0, extracted.stderr);
  const roots = readdirSync(target, { withFileTypes: true }); assert.equal(roots.length, 1); assert.ok(roots[0].isDirectory());
  const root = join(target, roots[0].name); checkLinks(root);
  const release = readRelease(root); assert.ok(release, "release.json missing");
  for (const file of ["bin/barry", "runtime/bin/node"]) assert.ok(statSync(join(root, file)).mode & 0o111, `${file} not executable`);
  const digest = hash(readFileSync(tarball));
  if (existsSync(`${tarball}.sha256`)) assert.equal(readFileSync(`${tarball}.sha256`, "utf8").trim().split(/\s+/)[0], digest, "tarball digest differs from sidecar");
  return { root, release, tarballSha256: digest };
}
export async function verifyReleaseUpgrade(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { candidate: { type: "string" }, previous: { type: "string" }, output: { type: "string" } } });
  if (!values.candidate) throw new Error("usage: verify-release-upgrade.ts --candidate <real-tarball> [--previous <real-tarball>] [--output <new-directory>]");
  const root = values.output ? resolve(values.output) : mkdtempSync(join(tmpdir(), "barry-release-upgrade-"));
  if (values.output) mkdirSync(root, { mode: 0o700 });
  const results: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = { passed: false, completed: false, previousEvidence: Boolean(values.previous), healthCertified: false, healthPolicy: "User services are deliberately disabled; this matrix does not certify running system health.", logicalNormalization, platform: `${process.platform}-${process.arch}`, node: process.version, results };
  const save = () => writeFileSync(join(root, "acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  save(); console.log(`Receipt: ${join(root, "acceptance.json")}`);
  const home = join(root, "home"), instance = join(root, "instance"); mkdirSync(home);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BARRY_") && !key.endsWith("API_KEY") && !key.endsWith("TOKEN"))), HOME: home, BARRY_HOME: instance, PATH: `${join(instance, "bin")}:/usr/bin:/bin`, BARRY_OLLAMA_URL: "http://127.0.0.1:1", LOG_LEVEL: "silent" };
  let installed: string | undefined, cleanupProgram: string | undefined;
  const run = (program: string, argv: string[], expected = 0) => {
    const result = execute(program, argv, root, env, 300000);
    results.push({ command: [program, ...argv], ...result }); save();
    assert.equal(result.status, expected, `${argv.join(" ")}: ${result.error ?? result.stderr ?? result.stdout}`); return result;
  };
  const support = join(instance, "app-support"), current = join(support, "current");
  const selectedStores = () => {
    const stores = join(support, "stores"), selector = join(stores, "active.json");
    return existsSync(selector) ? join(stores, "generations", (JSON.parse(readFileSync(selector, "utf8")) as { id: string }).id) : stores;
  };
  const disableUserServices = () => {
    const definitions = JSON.parse(readFileSync(join(support, "managed-definitions.json"), "utf8")) as Array<{ name: string; domain: string; user?: string }>;
    for (const definition of definitions) if (definition.domain !== "system" && !definition.user) run(join(current, "bin/barry"), ["service", "disable", definition.name]);
    return definitions.filter(definition => definition.domain === "system" || definition.user).map(definition => `service:${definition.name}`);
  };
  const doctor = (stage: string) => {
    const expectedSystem = disableUserServices(), result = execute(join(current, "bin/barry"), ["doctor", "--json", "--strict"], root, env);
    results.push({ stage, doctor: result }); save();
    const value = JSON.parse(result.stdout) as { installation: Array<{ name: string; status: string; detail: string }> };
    const failures = value.installation.filter(check => check.status === "fail");
    const serviceFailures = failures.filter(check => check.name.startsWith("service:"));
    const expected = failures.filter(check => expectedSystem.includes(check.name) || check.name === "services" && isExpectedSystemDrift(check.detail, expectedSystem, serviceFailures));
    assert.deepEqual(failures, expected, `${stage}: unexpected strict doctor failures: ${json(failures)}`);
    if (failures.length) {
      assert.equal(result.status, 1, "strict doctor must fail for unsupported/unregistered system services");
      results.push({ stage, strictDoctorPassed: false, healthCertified: false, reason: "isolated unprivileged fixture cannot certify declared system-service health", expectedFailures: failures });
    } else { assert.equal(result.status, 0, result.stderr); results.push({ stage, strictDoctorPassed: true, healthCertified: false }); }
    save(); return failures.length === 0;
  };
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("real release upgrade verification requires macOS arm64; no runtime stub is accepted");
    assert.notEqual(process.getuid?.(), 0, "run the release fixture as an ordinary user");
    const candidate = unpack(resolve(values.candidate), join(root, "candidate"));
    const previous = values.previous ? unpack(resolve(values.previous), join(root, "previous"), true) : undefined;
    report.artifacts = { candidate, previous: previous ?? null }; save();
    if (previous) assert.notEqual(previous.release.version, candidate.release.version, "previous and candidate versions must differ");
    const first = previous ?? candidate;
    cleanupProgram = join(first.root, "bin/barry");
    // Use this artifact's own schema fixtures, never the candidate SDK to seed
    // a prior release. Legacy row ownership/FTS/archive fixtures become real
    // retained data before the normal installer provisions the instance.
    const fixture = join(first.root, "cli/scripts/verify-nodes.ts");
    assert.ok(existsSync(fixture), "release lacks its own migration fixture helper; cannot certify populated-store compatibility");
    run(join(first.root, "runtime/bin/node"), ["--import", join(first.root, "node_modules/tsx/dist/loader.mjs"), fixture, "--seed", "release-matrix"]);
    report.seedFixture = { helper: fixture, data: JSON.parse(readFileSync(join(instance, "seed.json"), "utf8")) }; save();
    run(join(first.root, "bin/barry"), ["setup", "--no-start"]); installed = join(current, "bin/barry");
    assert.equal(readRelease(current)?.version, first.release.version);
    assert.ok(realpathSync(current).startsWith(realpathSync(join(support, "releases")) + "/"), "current release must resolve within the installed releases directory");
    const firstHealth = doctor("initial");
    // Ordinary CLI backup/restore prepares a generation before schema upgrades.
    const backup = join(root, "initial-backup");
    run(installed, ["db", "backup", backup]); run(installed, ["db", "restore", backup]);
    disableUserServices();
    const initial = captureStores(selectedStores(), true, join(root, "snapshots", "initial")); report.initialStores = initial; save();
    if (!previous) {
      report.passed = true; report.strictDoctorPassed = firstHealth; report.pending = ["No real previous release supplied; upgrade/rollback compatibility has not been exercised."];
    } else {
      run(join(candidate.root, "bin/barry"), ["upgrade", "--yes"]);
      assert.equal(readRelease(current)?.version, candidate.release.version);
      const candidateHealth = doctor("candidate"), upgraded = captureStores(selectedStores(), false, join(root, "snapshots", "candidate")); report.candidateStores = upgraded;
      compareStores(initial, upgraded, isDeepStrictEqual(previous.release.stores, candidate.release.stores));
      const directory = join(support, "releases", "upgrades");
      const receipts = () => readdirSync(directory).filter(name => name.endsWith(".json")).sort().reverse().map(name => receiptSchema.parse(JSON.parse(readFileSync(join(directory, name), "utf8"))));
      const upgrade = receipts()[0]; assert.equal(upgrade.kind, "upgrade"); assert.equal(upgrade.state, "complete"); assert.deepEqual(upgrade.from, { kind: "release", version: previous.release.version, commit: previous.release.commit }); assert.deepEqual(upgrade.to, { kind: "release", version: candidate.release.version, commit: candidate.release.commit });
      assert.ok(upgrade.snapshot && existsSync(upgrade.snapshot)); report.upgradeReceipt = upgrade; save();
      run(installed, ["upgrade", "--rollback", "--yes"]);
      assert.equal(readRelease(current)?.version, previous.release.version);
      const rollbackHealth = doctor("rollback"), rolledBack = captureStores(selectedStores(), false, join(root, "snapshots", "rollback")); report.rollbackStores = rolledBack; compareStores(initial, rolledBack, true);
      const rollback = receipts()[0]; assert.equal(rollback.kind, "rollback"); assert.equal(rollback.state, "complete"); assert.deepEqual(rollback.from, upgrade.to); assert.deepEqual(rollback.to, upgrade.from); report.rollbackReceipt = rollback;
      report.strictDoctorPassed = firstHealth && candidateHealth && rollbackHealth; report.passed = true;
    }
  } catch (error) { report.failure = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    const cleanupTarget = installed && existsSync(installed) ? installed : cleanupProgram;
    if (cleanupTarget && existsSync(cleanupTarget)) {
      const cleanup = execute(cleanupTarget, ["setup", "--uninstall", "--purge", "--yes"], root, env); report.cleanup = cleanup;
      if (cleanup.status !== 0) { report.passed = false; process.exitCode = 1; }
    }
    report.completed = true; save();
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyReleaseUpgrade(process.argv.slice(2));
