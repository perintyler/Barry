import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const [candidateArg, outputArg, repository = process.env.GITHUB_REPOSITORY] = process.argv.slice(2);
if (!candidateArg || !outputArg || !repository) throw new Error("usage: run-release-matrix.mjs <candidate-tarball> <new-output> <repository>");
const candidate = resolve(candidateArg), output = resolve(outputArg);
mkdirSync(output, { mode: 0o700 });
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 ** 2 });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
const releases = JSON.parse(run("gh", ["release", "list", "--repo", repository, "--exclude-drafts", "--exclude-pre-releases", "--limit", "3", "--json", "tagName"]));
const summary = { passed: false, previousEvidence: releases.length > 0, healthCertified: false, candidate, receipts: [] };
const save = () => writeFileSync(join(output, "matrix-summary.json"), JSON.stringify(summary, null, 2) + "\n");
save();
for (const [index, release] of (releases.length ? releases : [null]).entries()) {
  let previous;
  if (release) {
    const directory = join(output, `previous-${index}`); mkdirSync(directory);
    run("gh", ["release", "download", release.tagName, "--repo", repository, "--pattern", "barry-*-darwin-arm64.tar.gz", "--pattern", "*.sha256", "--dir", directory]);
    const files = readdirSync(directory).filter(file => /^barry-.+-darwin-arm64\.tar\.gz$/.test(file));
    if (files.length !== 1) throw new Error(`${release.tagName}: expected one macOS arm64 tarball`);
    previous = join(directory, files[0]);
    if (!existsSync(`${previous}.sha256`)) throw new Error(`${release.tagName}: missing tarball SHA-256 sidecar`);
  }
  const directory = join(output, `fixture-${index}`);
  const args = ["--import", "tsx", "cli/scripts/verify-release-upgrade.ts", "--candidate", candidate, "--output", directory, ...(previous ? ["--previous", previous] : [])];
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 32 * 1024 ** 2 });
  writeFileSync(join(output, `fixture-${index}.log`), (result.stdout ?? "") + (result.stderr ?? ""), { mode: 0o600 });
  if (result.error || result.status !== 0) {
    const path = join(directory, "acceptance.json");
    const failure = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).failure : undefined;
    throw new Error(`release matrix failed; inspect ${path}: ${failure ?? result.error?.message ?? `exit ${result.status}`}`);
  }
  const receipt = JSON.parse(readFileSync(join(directory, "acceptance.json"), "utf8"));
  if (!receipt.passed || !receipt.completed) throw new Error(`incomplete matrix receipt: ${directory}`);
  summary.receipts.push({ tag: release?.tagName ?? "bootstrap", path: join(directory, "acceptance.json"), previousEvidence: receipt.previousEvidence, healthCertified: receipt.healthCertified }); save();
}
summary.healthCertified = summary.receipts.every(receipt => receipt.healthCertified);
summary.passed = true; save();
console.log(`Release matrix passed ${summary.receipts.length} fixture(s); previous evidence: ${summary.previousEvidence}; system health certified: ${summary.healthCertified}`);
