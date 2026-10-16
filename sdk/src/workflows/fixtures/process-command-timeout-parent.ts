/** Actual ProcessExecutor command deadline fixture; no mocked lifecycle or capacity. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processBootIdentity } from "../work-process-supervisor.js";

const self = fileURLToPath(import.meta.url), loader = import.meta.resolve("tsx");
const root = realpathSync(process.argv[3] ?? "");
assert.equal(dirname(root), realpathSync(tmpdir()));assert.match(basename(root), /^process-command-timeout-[A-Za-z0-9]+$/);
function metadata(pid = process.pid) {
  return { pid, pgid: Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim()),
    pidStartedAt: Math.floor(Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim()) / 1000), bootIdentity: processBootIdentity(), hostname: hostname() };
}
async function send(value: unknown) { assert.ok(process.send);await new Promise<void>((resolve, reject) => process.send!(value, undefined, undefined, (error: Error | null) => error ? reject(error) : resolve())); }
const mode = process.argv[2];
if (mode === "descendant") {
  process.on("SIGTERM", () => {});writeFileSync(join(root, "descendant.json"), JSON.stringify(metadata()));setInterval(() => {}, 1000);
} else if (mode === "application") {
  process.on("SIGTERM", () => process.exit(0));writeFileSync(join(root, "application.json"), JSON.stringify({ ...metadata(), startedAt: Date.now() }));
  if (process.argv[4] !== "graceful") {
    const child = spawn(process.execPath, ["--import", loader, self, "descendant", root], { cwd: root,
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), LC_ALL: "C" }, stdio: "ignore" });
    child.once("error", () => process.exit(2));
    while (!existsSync(join(root, "descendant.json"))) await new Promise(resolve => setTimeout(resolve, 10));
  }
  writeFileSync(join(root, "native-ready.json"), JSON.stringify({ at: Date.now() }));setInterval(() => {}, 1000);
} else if (mode === "parent") {
  const commandTimeout = Number(process.argv[4]);assert.ok(Number.isSafeInteger(commandTimeout) && commandTimeout > 0);
  const freezeInert = process.argv[5] === "freeze-inert";
  const [{ ProcessExecutor }, { WorkArtifactStore }, { prepareProcessProgram }, { executorStartSchema }, { boundFingerprint }, { artifactAbi }] = await Promise.all([
    import("../executor.js"), import("../work-artifacts.js"), import("../work-process-program.js"), import("../work-contracts.js"), import("../../bounds/workflow-bounds.js"), import("../artifacts.js"),
  ]);
  mkdirSync(join(root, "temporary"));const artifacts = new WorkArtifactStore(join(root, "artifacts"));
  const source = join(root, "main.sh");writeFileSync(source, "printf '{}'\n");
  const evidence = { identity: "command-fixture", traits: [], bound: null, tools: { "bash:Bash": "write" as const }, contracts: { "bash:Bash": boundFingerprint({ contract: "trusted native command fixture" }) } };
  const scope = { ...evidence, fingerprint: boundFingerprint(evidence) };
  const prepared = prepareProcessProgram({ artifacts, source, runtime: "/bin/sh", activity_type: "fixture:command@1", installation: "command-fixture", scope,
    argv: [{ source: true }], cwd: root, output: "json" });
  const deadline = Date.now() + 60000;
  const start = executorStartSchema.parse({ version: 2, owner: "fixture-owner", work_id: "fixture-work", workflow_id: "fixture-workflow", activity_id: "fixture-activity", attempt_id: "fixture-attempt",
    request_hash: boundFingerprint({}), plan_digest: boundFingerprint(prepared.program), grant_ref: "fixture-bash-grant", grant_revision: 1, source: prepared.source,
    execution_fence: 1, deadline, inputs: {}, effect_policy: { class: "non-repeatable", max_attempts: 1 },
    resources: { executor: "process", lane: "unscheduled", logical_reservation: "fixture-logical", host_reservation: null, endpoint: null },
    executor_generation: "work-v2", process_program: prepared.program, validation: { mode: "none" }, activity_type: prepared.program.activity_type, output_identity: null });
  const task = { owner: start.owner, runId: start.workflow_id, activityId: start.activity_id, token: start.attempt_id, type: prepared.program.activity_type, input: {}, attempt: 1,
    idempotencyKey: "command-timeout-fixture", deadline, timeoutMs: 60000, heartbeatMs: 1000, artifact: prepared.source.digest, grantRevision: 1, work: start };
  const command = { runtime: prepared.program.runtime, ...(prepared.program.runtime_path ? { runtime_path: prepared.program.runtime_path } : {}), cwd: prepared.program.cwd,
    timeout_ms: commandTimeout, files_exist: [], command: `exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(loader)} ${JSON.stringify(self)} application ${JSON.stringify(root)}${freezeInert ? " graceful" : ""}` };
  const executor = new ProcessExecutor({ artifacts, installation: "command-fixture", tempRoot: join(root, "temporary") });
  let native: ReturnType<typeof metadata> | undefined, physical: unknown;
  const operation = executor.supervisedCommand({ path: artifacts.path(prepared.source), digest: prepared.source.digest, type: prepared.program.activity_type, version: "1", abi: artifactAbi }, task, command, new AbortController().signal,
    { beforeInput: async pid => {
      native = metadata(pid);writeFileSync(join(root, "guardian.json"), JSON.stringify(native));
      if (freezeInert) {
        // The actual guardian cannot read private application input or emit
        // started until the outer test resumes this exact captured process.
        process.kill(pid, "SIGSTOP");
        await send({ ready: true, inert: true, parent: metadata(), guardian: native, commandTimeout, deadline });
        // beforeInput finishes and its Promise continuation writes FD3 before
        // this phase. Guardian remains frozen throughout that input release.
        setImmediate(() => process.kill(process.pid, "SIGSTOP"));
      }
    }, closed: value => { physical = value; } });
  const outcome = operation.then(report => ({ report }), error => ({ error: error instanceof Error ? error.message : String(error) }));
  try {
    while (!freezeInert && !existsSync(join(root, "native-ready.json"))) {
      const completed = await Promise.race([outcome.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 10))]);
      if (completed) throw new Error("Native command ended before readiness");
    }
    if (!freezeInert) {
      assert.ok(native);await send({ ready: true, parent: metadata(), guardian: native,
        application: JSON.parse(readFileSync(join(root, "application.json"), "utf8")), descendant: JSON.parse(readFileSync(join(root, "descendant.json"), "utf8")), commandTimeout, deadline });
    }
    const result = await outcome;
    writeFileSync(join(root, "result.json"), JSON.stringify({ ...result, physical }));
    await executor.close();artifacts.close();process.disconnect?.();process.exit(0);
  } catch (error) { await executor.close();artifacts.close();throw error; }
} else throw new Error("Unknown task-owned command timeout fixture mode");
