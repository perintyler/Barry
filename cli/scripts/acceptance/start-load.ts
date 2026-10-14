/** Start a retained, detached one-hour then eight-hour acceptance lane with durable receipts. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { nodeTsArgv } from "@barry-rocks/sdk/internal/services";
const { values, positionals } = parseArgs({ options: { worker: { type: "boolean" }, network: { type: "boolean" }, revision: { type: "string" } }, allowPositionals: true });
const worker = values.worker === true, network = values.network === true, raw = positionals[0];
if (positionals.length !== 1 || !raw?.startsWith("/")) throw new Error("usage: start-load.ts [--network] <absolute-new-persistent-output>");
const root = resolve(raw), checkout = fileURLToPath(new URL("../../..", import.meta.url));
const currentRevision = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!worker && values.revision) throw new Error("--revision is reserved for the detached worker");
const revision = worker ? values.revision ?? currentRevision : currentRevision;
const path = join(root, "lane.json");
const save = (phase: string, extra: object = {}) => writeFileSync(path, JSON.stringify({ revision, pid: process.pid, transport: network ? "HTTP loopback" : "in-process", phase, at: new Date().toISOString(), ...extra }, null, 2), { mode: 0o600 });
const requireUnchangedCheckout = () => {
  assert.equal(execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), revision, "retained checkout revision changed");
  assert.equal(execFileSync("git", ["-C", checkout, "status", "--porcelain"], { encoding: "utf8" }).trim(), "", "retained checkout must be clean");
};
if (!worker) {
  requireUnchangedCheckout();
  if (existsSync(root)) throw new Error("output must not exist"); mkdirSync(root, { recursive: true, mode: 0o700 }); save("prepared");
  const argv = nodeTsArgv(fileURLToPath(import.meta.url)), log = openSync(join(root, "lane.log"), "wx", 0o600);
  const child = spawn(argv[0], [...argv.slice(1), "--worker", "--revision", revision, ...(network ? ["--network"] : []), root], { cwd: checkout, detached: true, stdio: ["ignore", log, log], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LC_ALL: "C", LANG: "C" } });
  closeSync(log); child.unref(); console.log(JSON.stringify({ revision, pid: child.pid, output: root, transport: network ? "HTTP loopback" : "in-process", scheduledHours: 9 }));
} else {
  try {
    for (const lane of ["one-hour", "overnight"]) {
      requireUnchangedCheckout();
      save(lane);
      const script = network ? join(checkout, "bags/workflows/src/network-load-probe.ts") : join(import.meta.dirname, "verify-load.ts");
      const argv = nodeTsArgv(script);
      const duration = network ? (lane === "one-hour" ? "3600" : "28800") : lane;
      const child = spawn(argv[0], [...argv.slice(1), duration, join(root, lane)], { cwd: checkout, stdio: "inherit" });
      const stop = () => child.kill("SIGTERM"); process.once("SIGTERM", stop); process.once("SIGINT", stop);
      const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
      process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
      assert.equal(code, 0, `${lane} failed; overnight does not proceed after a failed hour gate`);
    }
    requireUnchangedCheckout();
    save("passed");
  } catch (error) { save("failed", { problem: String(error) }); throw error; }
}
