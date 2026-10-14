/** Release-only long-duration lane. The probe records and checks unchanged source. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeTsArgv } from "@barry-rocks/sdk/internal/services";
const [lane, raw] = process.argv.slice(2);
if (!["one-hour", "overnight"].includes(lane) || !raw?.startsWith("/")) throw new Error("usage: verify-load.ts one-hour|overnight <absolute-new-output>");
const root = resolve(raw), checkout = fileURLToPath(new URL("../../..", import.meta.url));
assert.equal(execFileSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" }).trim(), "", "load acceptance requires a clean committed checkout");
if (existsSync(root)) throw new Error("output must not exist"); mkdirSync(root, { recursive: true, mode: 0o700 });
const duration = lane === "one-hour" ? 3600 : 28800;
const revision = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const receipt = { lane, revision, durationSeconds: duration, node: process.version, started: new Date().toISOString(), completed: false, passed: false, pid: 0 };
const save = () => writeFileSync(join(root, "acceptance.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
save();
const command = nodeTsArgv(join(checkout, "bags/workflows/src/load-probe.ts"));
const out = openSync(join(root, "report.json"), "wx", 0o600), err = openSync(join(root, "errors.log"), "wx", 0o600);
const child = spawn(command[0], [...command.slice(1), String(duration)], { cwd: checkout, stdio: ["ignore", out, err] });
closeSync(out); closeSync(err); receipt.pid = child.pid!; save();
const stop = () => child.kill("SIGTERM"); process.once("SIGTERM", stop); process.once("SIGINT", stop);
try {
  const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
  if (code !== 0) {
    const details = readFileSync(join(root, "errors.log"), "utf8").trim();
    throw new Error(`load probe failed with exit ${String(code)}; see ${join(root, "errors.log")}${details ? `\n${details}` : ""}`);
  }
  const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
  assert.ok(report.durationSeconds >= duration); assert.equal(report.failures, 0);
  assert.equal(report.sourceAtStart, report.sourceAtEnd); assert.equal(report.revision, revision);
  receipt.passed = true; console.log(`PASS ${lane} unchanged-source declared workload ${revision}`);
} finally { receipt.completed = true; save(); }
