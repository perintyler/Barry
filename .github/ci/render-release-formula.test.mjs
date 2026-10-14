import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./render-release-formula.mjs", import.meta.url));
function fixture(t, version = "1.2.3-rc.1") {
  const directory = mkdtempSync(join(tmpdir(), "barry-formula-mirror-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = `barry-${version}-darwin-arm64.tar.gz`;
  const bytes = Buffer.from("actual fixture artifact bytes\n");
  writeFileSync(join(directory, filename), bytes);
  return { directory, version, filename, digest: createHash("sha256").update(bytes).digest("hex"), formula: join(directory, "barry.rb") };
}
function run(f, args) {
  return spawnSync(process.execPath, [script, f.directory, ...args], { cwd: f.directory, encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: "perintyler/barry-dev" } });
}

test("renders the publishing mirror URL and actual bytes/version from any cwd", t => {
  const f = fixture(t), result = run(f, [`v${f.version}`, "public-mirror/barry"]);
  assert.equal(result.status, 0, result.stderr);
  const formula = readFileSync(f.formula, "utf8");
  assert(formula.includes(`url "https://github.com/public-mirror/barry/releases/download/${encodeURIComponent(`v${f.version}`)}/${encodeURIComponent(f.filename)}"`));
  assert(formula.includes(`version "${f.version}"`));
  assert(formula.includes(`sha256 "${f.digest}"`));
  assert(!formula.includes("perintyler/barry-dev"));
  assert(!formula.includes("@@"));
});

test("missing or invalid publishing repository refuses without creating output", t => {
  const f = fixture(t);
  for (const repository of [undefined, "", "owner", "owner/repo/extra", "https://github.com/owner/repo", "../repo", "owner/..", "-owner/repo", "owner/repo?token=value", "owner/repo\nextra", "owner//repo"]) {
    const result = run(f, [`v${f.version}`, ...(repository === undefined ? [] : [repository])]);
    assert.notEqual(result.status, 0, `accepted ${JSON.stringify(repository)}`);
    assert.match(result.stderr, /usage:|invalid publishing repository/);
    assert(!existsSync(f.formula), `created output for ${JSON.stringify(repository)}`);
  }
});

test("tag/version mismatch and unsupported artifact versions refuse before writing", t => {
  const f = fixture(t); writeFileSync(f.formula, "retained formula\n");
  for (const tag of ["v9.9.9", f.version, "release/current"]) {
    const result = run(f, [tag, "public-mirror/barry"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match tarball version/);
    assert.equal(readFileSync(f.formula, "utf8"), "retained formula\n");
  }
  const metadata = fixture(t, "1.2.3+mirror.1");
  const result = run(metadata, [`v${metadata.version}`, "public-mirror/barry"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected tarball name or version/);
  assert(!existsSync(metadata.formula));
});
