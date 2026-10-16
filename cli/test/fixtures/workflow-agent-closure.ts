/** Actual Pi + production retained runtime composition. Trusted fixture policy only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { approveWorkflowBounds, boundFingerprint } from "@barry-rocks/sdk/bounds";
import { SessionReconciliationRequired, WorkflowSessionTurns } from "@barry-rocks/sdk/internal/sessions";
import { bootstrapStoreGeneration, withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { WorkArtifactStore } from "@barry-rocks/sdk/internal/workflows";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import type { WorkflowDestinationBinding } from "@barry-rocks/sessions-bag/store/workflow-destinations";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { SessionsWorkflowBackend, type WorkflowHarnessLaunch } from "../../../bags/sessions/api/src/workflow-session-backend.js";
import { prepareWorkflowProcessHarness, inspectWorkflowHarnessOutcome, type WorkflowProcessHarnessOptions } from "../../../bags/sessions/api/src/workflow-process-harness.js";
import { captureWorkflowRuntime, materializeWorkflowRuntime, type WorkflowRuntimeReference } from "../../../bags/sessions/api/src/workflow-runtime-closure.js";

const worker = fileURLToPath(new URL("../../../bags/sessions/api/src/workflow-harness-child.ts", import.meta.url));
const adapter = new URL("../../../adapters/sessions/pi/dist/index.js", import.meta.url).href;
const workspace = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
function installedDependencyRoot() {
  let directory = realpathSync(fileURLToPath(new URL("../../../adapters/sessions/pi/node_modules/@earendil-works/pi-coding-agent", import.meta.url)));
  while (basename(directory) !== ".pnpm") { assert.notEqual(dirname(directory), directory, "Expected explicit installed pnpm package instance root");directory = dirname(directory); }
  return directory;
}
const maximum = 256 * 1024 * 1024;
let installation: { root: string; artifacts: WorkArtifactStore; reference: WorkflowRuntimeReference; captureMs: number } | undefined;
function guard(root: string) { assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()));assert.match(basename(root), /^workflow-agent-closure-[A-Za-z0-9]+$/); }
function baseline() {
  if (!installation) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-agent-closure-")));guard(root);
    const artifacts = new WorkArtifactStore(join(root, "artifacts"), maximum);
    const started = performance.now();
    const reference = captureWorkflowRuntime({ artifacts, harness: "pi", adapterModule: adapter, workerEntrypoint: worker, allowedRoots: [workspace, installedDependencyRoot()] });
    installation = { root, artifacts, reference, captureMs: performance.now() - started };
  }
  return installation;
}
export function closeClosureInstallation() { if (installation) { installation.artifacts.close();rmSync(installation.root, { recursive: true, force: true });installation = undefined; } }
export function groupExists(pgid: number) { try { process.kill(-pgid, 0);return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;throw error; } }
export async function workflowAgentClosure(options: { mode?: "plain" | "tool"; mutateAfterCheckpoint?: boolean; mutateCallerOptions?: boolean; adapterSelection?: "non-durable" | "malformed-open" | "blocked" } = {}) {
  // Registration occurs before accepting the original turn deadline. Capture real
  // built packages once, materialize an installed generation, then capture THAT
  // generation through the same production API. Never mutate repository deps.
  const source = baseline(), root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-agent-closure-")));guard(root);
  const materializeStarted = performance.now();
  const installedPath = join(root, "installed"), installed = materializeWorkflowRuntime(source.artifacts, source.reference, "pi", installedPath);
  const installedMaterializeMs = performance.now() - materializeStarted;
  let selectedAdapter = installed.adapter;
  if (options.adapterSelection) {
    selectedAdapter = join(dirname(installed.adapter), "closure-selection.mjs");
    const gate = options.adapterSelection === "blocked" ? `import{existsSync,writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(root, "selection-wait"))},'waiting',{mode:0o600});while(!existsSync(${JSON.stringify(join(root, "selection-continue"))}))await new Promise(resolve=>setTimeout(resolve,10));` : "";
    const override = options.adapterSelection === "non-durable" ? 'approvalContinuation:"ephemeral"' : options.adapterSelection === "malformed-open" ? 'openContinuation:{not:"a function"}' : "";
    // Negative selection fixtures wrap the actual compiled Pi adapter. No
    // substitute harness runs or returns a fabricated continuation/outcome.
    writeFileSync(selectedAdapter, `import base from './index.js';${gate}export default {...base,modes:{...base.modes,hosted:{...base.modes.hosted,${override}}}};`, { mode: 0o500 });
  }
  const artifacts = new WorkArtifactStore(join(root, "artifacts"), maximum);
  const registrationStarted = performance.now();
  const reference = captureWorkflowRuntime({ artifacts, harness: "pi", adapterModule: pathToFileURL(selectedAdapter).href, workerEntrypoint: installed.worker, runtime: installed.runtime, allowedRoots: [installedPath] });
  const timings = { baselineCaptureMs: source.captureMs, installedMaterializeMs, registrationCaptureMs: performance.now() - registrationStarted };
  const manifest = materializeManifest();
  function materializeManifest() { return JSON.parse(artifacts.verify({ digest: reference.digest, bytes: reference.bytes, purpose: "source", owner_identity: null, media_type: "application/octet-stream" }).toString()) as typeof installed.manifest; }
  function removeInstalled() { guard(root);rmSync(installedPath, { recursive: true, force: true }); }
  function poisonInstalled() {
    removeInstalled();mkdirSync(dirname(installed.adapter), { recursive: true });
    writeFileSync(installed.adapter, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(root, "installed-tripwire"))},'wrong');throw Error('installed replacement');`);
    mkdirSync(dirname(installed.runtime), { recursive: true });writeFileSync(installed.runtime, "#!/bin/sh\nexit 89\n", { mode: 0o500 });writeFileSync(installed.worker, "throw Error('installed worker replacement')");
  }
  mkdirSync(join(root, "home"), { mode: 0o700 });mkdirSync(join(root, "spool"), { mode: 0o700 });
  const saved = { home: process.env.BARRY_HOME, db: process.env.BARRY_SESSIONS_DB };
  closeSessionsDb();process.env.BARRY_HOME = join(root, "home");delete process.env.BARRY_SESSIONS_DB;bootstrapStoreGeneration(barryStoresDir());
  const identity = randomUUID(), bindingKey = "closure/" + randomUUID(), key = bindingKey + "/turn";
  const base = await approveWorkflowBounds({ identity, bags: [], tools: [], boundByName: async () => undefined });
  const { fingerprint: _fingerprint, ...original } = base;
  const evidence = { ...original, tools: { "pi:write": "write" as const }, contracts: { "pi:write": boundFingerprint({ fixture: "actual retained Pi native write" }) } };
  const scope = { ...evidence, fingerprint: boundFingerprint(evidence) };
  const result = "actual retained Pi result", content = "retained-original-effect\n", callId = "retained-write";
  const requests: { body: unknown; authorization: string | undefined; group: { pid: number; ppid: number; pgid: number; command: string }[]; handle: { pid: number; pgid: number } }[] = [];
  const providerErrors: string[] = [], configured: string[] = [], launches: WorkflowHarnessLaunch[] = [];
  let checkpointMutations = 0, callerMutations = 0, permitted = true;
  const provider = createServer((req, res) => {
    let raw = "";req.on("data", bytes => { raw += String(bytes); });req.on("end", () => {
      try {
        assert.equal(req.headers.authorization, "Bearer retained-local-key");
        const body = JSON.parse(raw), row = db.prepare("SELECT phase,handle_json FROM session_workflow_settlements ORDER BY rowid DESC LIMIT 1").get() as { phase: string; handle_json: string };
        assert.equal(row.phase, "input");const handle = JSON.parse(row.handle_json) as { pid: number; pgid: number };
        const group = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8", timeout: 1000 }).split("\n").flatMap(line => {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
          return match && Number(match[3]) === handle.pgid ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }] : [];
        });
        requests.push({ body, authorization: req.headers.authorization, group, handle });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "retained", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (options.mode === "tool" && requests.length === 1) {
          assert.ok((body.tools as { function?: { name?: string } }[]).some(tool => tool.function?.name === "write"));
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "write", arguments: JSON.stringify({ path: join(root, "native-effect.txt"), content }) } }] }, null);chunk({}, "tool_calls");
        } else { chunk({ role: "assistant", content: result }, null);chunk({}, "stop"); }
        res.end("data: [DONE]\n\n");
      } catch (error) { providerErrors.push(error instanceof Error ? error.stack ?? error.message : String(error));if (!res.headersSent) res.writeHead(500);res.end("Local retained provider refused request"); }
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  const declaration: WorkflowDestinationBinding = { bindingKey, sessionId: workflowSessionId(bindingKey, identity), identity, identityId: 42, actorId: 1, scope,
    selection: { harness: "pi", model: "openai/probe", endpoint, cwd: root, maxTurns: 4, deadline: Date.now() + 60000, runtime: reference } };
  const context = { identity };
  let db = withStoreContext(context, getSessionsSqlite);
  const journal = new Proxy(workflowTurnsStore, { get(target, property) { const value = Reflect.get(target, property);return typeof value === "function" ? (...args: unknown[]) => withStoreContext(context, () => value.apply(target, args)) : value; } });
  function make(selected = declaration) {
    return new SessionsWorkflowBackend({ db, declaration: selected, enforceable: value => boundFingerprint(value) === boundFingerprint(scope),
      authorize: async () => { assert.ok(permitted, "Trusted fixture authority revoked");assert.equal(selected.identity, identity);assert.ok(Date.now() < declaration.selection.deadline); },
      authorizeTool: async (_scope, call) => {
        if (options.mutateAfterCheckpoint && checkpointMutations === 0) {
          const segment = db.prepare("SELECT state FROM session_run_segments ORDER BY rowid LIMIT 1").get() as { state: string };assert.equal(segment.state, "interrupted");
          poisonInstalled();checkpointMutations++;
        }
        const input = call.input as { path?: unknown; content?: unknown } | null;
        return { allow: call.tool === "write" && !!input && input.path === join(root, "native-effect.txt") && input.content === content && Object.keys(input).length === 2 };
      },
      prepare: async launch => {
        launches.push(launch);
        const driverOptions: WorkflowProcessHarnessOptions = { harnessId: "pi", runtime: { artifacts, reference: { ...reference } }, spoolRoot: join(root, "spool"),
          inertEnvironment: { PATH: "/usr/bin:/bin", HOME: root, BARRY_HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "pi"), TMPDIR: tmpdir() },
          authorize: async () => {
            assert.ok(permitted, "Trusted fixture authority revoked");assert.ok(Date.now() < declaration.selection.deadline);
            if (options.mutateCallerOptions && callerMutations === 0) {
              assert.ok(driverOptions.runtime);driverOptions.runtime.reference.digest = "0".repeat(64);
              driverOptions.inertEnvironment.NODE_OPTIONS = "--import=/missing-caller-injection.mjs";
              callerMutations++;await Promise.resolve();
            }
          },
          configure: async candidate => {
            const fence = db.prepare("SELECT phase,handle_json FROM session_workflow_settlements WHERE segment_id=?").get(candidate.segmentId) as { phase: string; handle_json: string };
            assert.equal(fence.phase, "handled");assert.ok(JSON.parse(fence.handle_json).pid);configured.push(candidate.segmentId);
            return { sessionId: candidate.sessionId, cwd: root, model: "openai/probe", endpoint: { baseUrl: endpoint, apiKey: "retained-local-key" }, env: { HOME: root, PATH: "/usr/bin:/bin" }, mcpServers: {}, allowedNativeTools: options.mode === "tool" ? ["write"] : [] };
          },
        };
        return prepareWorkflowProcessHarness(driverOptions, launch);
      },
    });
  }
  let backend = make(), turns = new WorkflowSessionTurns(journal, backend);
  writeFileSync(join(root, "fixture.json"), JSON.stringify({ declaration, reference, installedPath, timings }), { mode: 0o600 });
  return { root, key, declaration, reference, manifest, artifacts, installedPath, installed, timings, result, content, callId, requests, providerErrors, launches, configured,
    get db() { return db; },get backend() { return backend; },get checkpointMutations() { return checkpointMutations; },get callerMutations() { return callerMutations; },
    removeInstalled, poisonInstalled,revoke: () => { permitted = false; },
    releaseSelect: () => writeFileSync(join(root, "selection-continue"), "continue", { mode: 0o600 }),
    start: async () => { const session = await turns.ensure(bindingKey, scope);return turns.turn(key, session, { text: "one retained original request" }, scope); },
    reopen: (runtime = reference) => { closeSessionsDb();db = withStoreContext(context, getSessionsSqlite);backend = make({ ...declaration, selection: { ...declaration.selection, runtime } });turns = new WorkflowSessionTurns(journal, backend); },
    corruptAdapter: () => { const file = manifest.files.find(item => item.path === manifest.adapter)!;const chunk = manifest.chunks.find(item => item.digest === file.storage.chunk)!;const path = artifacts.path({ ...chunk, purpose: "source", owner_identity: null, media_type: "application/octet-stream" });const bytes = readFileSync(path);bytes[file.storage.offset] ^= 1;chmodSync(path, 0o600);writeFileSync(path, bytes); },
    outcomes: () => readdirSync(join(root, "spool")).map(name => { const directory = join(root, "spool", name), binding = JSON.parse(readFileSync(join(directory, "binding.json"), "utf8"));return { directory, binding, outcome: inspectWorkflowHarnessOutcome(join(root, "spool"), binding) }; }),
    close: async (options: { preserve?: boolean; expectUnsettled?: boolean } = {}) => {
      const preserve = options.preserve || options.expectUnsettled;
      const failures: unknown[] = [];
      try { if (preserve) { await db.backup(join(root, "failure-sessions.db"));writeFileSync(join(root, "failure-settlements.json"), JSON.stringify(backend.destination.unsettled()), { mode: 0o600 }); }await backend.close();if (options.expectUnsettled) failures.push(new Error("Expected conservative preparation fence")); } catch (error) {
        const uncertain = (value: unknown): boolean => value instanceof SessionReconciliationRequired || value instanceof AggregateError && value.errors.length > 0 && value.errors.every(uncertain);
        if (!options.expectUnsettled || !uncertain(error)) failures.push(error);
      }
      provider.closeAllConnections();await new Promise<void>(resolve => provider.close(() => resolve()));closeSessionsDb();artifacts.close();
      if (saved.home === undefined) delete process.env.BARRY_HOME;else process.env.BARRY_HOME = saved.home;
      if (saved.db === undefined) delete process.env.BARRY_SESSIONS_DB;else process.env.BARRY_SESSIONS_DB = saved.db;
      if (!preserve && !failures.length) rmSync(root, { recursive: true, force: true });
      if (failures.length) throw new AggregateError(failures, "Retained fixture cleanup failed; preserved " + root);
    },
  };
}
