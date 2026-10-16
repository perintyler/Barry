import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContinuationHarness, SegmentOutcome, SessionEvent, SessionConfig } from "@barry-rocks/sdk/sessions";
import { approveWorkflowBounds, boundFingerprint } from "@barry-rocks/sdk/bounds";
import { processBootIdentity } from "@barry-rocks/sdk/internal/workflows";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { WorkflowSessionTurns, workflowSessionId, SessionReconciliationRequired } from "@barry-rocks/sdk/internal/sessions";
import { withStoreContext, bootstrapStoreGeneration } from "@barry-rocks/sdk/internal/stores";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import { classify, readProcessStartTime } from "@barry-rocks/sessions-bag/process-liveness";
import { SessionsWorkflowBackend, type WorkflowHarnessHandle, type PreparedWorkflowHarness } from "../../../bags/sessions/api/src/workflow-session-backend.js";

const self = fileURLToPath(import.meta.url), repo = fileURLToPath(new URL("../../../", import.meta.url));
const resultText = '{"answer":42,"source":"actual-pi"}';
function gate() { let release!: () => void;const promise = new Promise<void>(resolve => { release = resolve; });return { promise, release }; }

/** The child is inert until activate, and receives input only in begin. */
async function harnessChild() {
  assert.ok(process.send, "Fixture child requires its private IPC channel");
  const directory = realpathSync(process.env.HOME ?? "");
  assert.equal(dirname(directory), realpathSync(tmpdir()));
  assert.match(basename(directory), /^workflow-agent-destination-[A-Za-z0-9]+$/);
  assert.equal(realpathSync(process.env.BARRY_HOME ?? ""), join(directory, "home"));
  assert.equal(process.env.PI_CODING_AGENT_DIR, join(process.env.HOME!, "pi"));
  let harness: ContinuationHarness | undefined;
  const send = (value: unknown) => new Promise<void>((resolve, reject) => process.send!(value, undefined, undefined, error => error ? reject(error) : resolve()));
  process.on("message", message => {
    void (async () => {
      const request = message as { id: string; command: string; config?: SessionConfig; content?: string };
      try {
        if (request.command === "activate") {
          assert.equal(harness, undefined);assert.ok(request.config);
          const { default: adapter } = await import("../../../adapters/sessions/pi/src/adapter.js");
          const open = adapter.modes.hosted?.openContinuation;assert.ok(open);
          harness = await open(request.config, async () => { throw new Error("Tool-free fixture cannot start a nested engine"); });
          await send({ id: request.id, value: { approvalContinuation: harness.approvalContinuation } });
        } else if (request.command === "begin") {
          assert.ok(harness);assert.equal(typeof request.content, "string");
          const outcome = await harness.begin(request.content!, event => send({ id: request.id, event }));
          await send({ id: request.id, value: outcome });
        } else if (request.command === "interrupt") {
          await harness?.interrupt();await send({ id: request.id, value: null });
        } else if (request.command === "close" || request.command === "dispose") {
          await harness?.close();await send({ id: request.id, value: null });process.disconnect();process.exit(0);
        } else throw new Error("Unknown fixture command");
      } catch (error) { await send({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
    })();
  });
  await send({ ready: true });
}

/** Actual migrated Sessions storage, actual backend, actual full Pi SDK and local provider. */
export async function workflowAgentDestination(options: { holdClose?: boolean; proofUnavailable?: boolean; holdAcquire?: boolean; deadlineMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "workflow-agent-destination-"));
  mkdirSync(join(root, "home"));
  const context = { identity: randomUUID() }, bindingKey = "fixture/" + randomUUID(), key = bindingKey + "/turn";
  const scope = await approveWorkflowBounds({ identity: context.identity, bags: [], tools: [], boundByName: async () => undefined });
  const previousDatabaseOverride = process.env.BARRY_SESSIONS_DB;
  delete process.env.BARRY_SESSIONS_DB;
  bootstrapStoreGeneration(barryStoresDir());
  let db = withStoreContext(context, getSessionsSqlite);
  const requests: { body: unknown; phase: string; handle: unknown; authorization: string | null }[] = [];
  const provider = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer local-fixture-key");
    let raw = "";req.on("data", bytes => { raw += String(bytes); });req.on("end", () => {
      const body = JSON.parse(raw);
      const row = db.prepare("SELECT phase,handle_json FROM session_workflow_settlements ORDER BY rowid DESC LIMIT 1").get() as { phase: string; handle_json: string };
      requests.push({ body, phase: row.phase, handle: JSON.parse(row.handle_json), authorization: req.headers.authorization ?? null });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "destination", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: "assistant", content: resultText }, null);chunk({}, "stop");res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  const declaration = { bindingKey, sessionId: workflowSessionId(bindingKey, context.identity), identity: context.identity, identityId: 42, actorId: 1, scope,
    selection: { harness: "pi", model: "openai/probe", endpoint, cwd: root, maxTurns: 5, deadline: Date.now() + (options.deadlineMs ?? 60000) } };
  const closeGate = gate();if (!options.holdClose) closeGate.release();
  const closing = gate(), acquiring = gate(), acquireGate = gate();if (!options.holdAcquire) acquireGate.release();
  let authorizationGate: ReturnType<typeof gate> | undefined, authorizationEntered = gate();
  let prepares = 0, activations = 0, acquired = 0, released = 0;
  const children: { pid: number; handle: WorkflowHarnessHandle; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; stop(): Promise<void>; done(): boolean }[] = [];
  const prepare = async (): Promise<PreparedWorkflowHarness> => {
    prepares++;const beforeRequests = requests.length;
    const child = spawn(process.execPath, ["--import", "tsx", self, "harness"], { cwd: join(repo, "cli"), env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: root, BARRY_HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "pi") }, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout!.resume();
    let stderr = "", done = false;child.stderr!.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-120000); });
    const ready = gate(), pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; emit?: (event: SessionEvent) => Promise<void>; events: Promise<void> }>();
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => { done = true;for (const operation of pending.values()) operation.reject(new Error(`Pi fixture child closed ${code}/${signal}: ${stderr}`));pending.clear();resolve({ code, signal }); }));
    child.on("message", raw => {
      const message = raw as { ready?: boolean; id?: string; event?: SessionEvent; value?: unknown; error?: string };
      if (message.ready) { ready.release();return; }
      const operation = pending.get(message.id ?? "");if (!operation) return;
      if (message.event) operation.events = operation.events.then(() => operation.emit?.(message.event!) ?? Promise.resolve());
      else { pending.delete(message.id!);void operation.events.then(() => message.error ? operation.reject(new Error(message.error)) : operation.resolve(message.value), operation.reject); }
    });
    const rpc = (command: string, data: Record<string, unknown> = {}, emit?: (event: SessionEvent) => Promise<void>) => new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();pending.set(id, { resolve, reject, emit, events: Promise.resolve() });child.send({ id, command, ...data }, error => { if (error) { pending.delete(id);reject(error); } });
    });
    try { await Promise.race([ready.promise, closed.then(() => { throw new Error("Inert Pi child failed readiness: " + stderr); })]); }
    catch (error) { if (!done) child.kill("SIGTERM");await closed;throw error; }
    assert.ok(child.pid);const start = readProcessStartTime(child.pid);assert.notEqual(start, null);
    const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child.pid)], { encoding: "utf8" }).trim());
    assert.equal(pgid, child.pid, "Prepared child must own its detached process group");
    const handle: WorkflowHarnessHandle = { kind: "process", pid: child.pid, pgid, bootIdentity: processBootIdentity(), pidStartedAt: start!, hostname: hostname() };
    const stop = async () => { if (!done) await rpc("dispose");assert.deepEqual(await closed, { code: 0, signal: null }, stderr); };
    children.push({ pid: child.pid, handle, closed, stop, done: () => done });
    return { handle,
      activate: async () => {
        const stored = db.prepare("SELECT phase,handle_json FROM session_workflow_settlements ORDER BY rowid DESC LIMIT 1").get() as { phase: string; handle_json: string };
        assert.equal(stored.phase, "handled");assert.equal(JSON.parse(stored.handle_json).pid, child.pid);assert.equal(requests.length, beforeRequests);
        activations++;
        const activated = await rpc("activate", { config: { sessionId: declaration.sessionId, cwd: root, env: { HOME: root, PATH: process.env.PATH }, model: "openai/probe", endpoint: { baseUrl: endpoint, apiKey: "local-fixture-key" }, mcpServers: {}, allowedNativeTools: [] } }) as { approvalContinuation: "durable" };
        assert.equal(activated.approvalContinuation, "durable");
        return { approvalContinuation: activated.approvalContinuation,
          validate: () => { throw new Error("This tool-free fixture does not restore approval checkpoints"); },
          restore: async () => { throw new Error("This tool-free fixture does not restore approval checkpoints"); },
          begin: async (content, emit) => await rpc("begin", { content }, emit) as SegmentOutcome,
          interrupt: async () => { await rpc("interrupt"); },
          close: async () => { closing.release();await closeGate.promise;await stop(); },
        };
      },
      proveCessation: async requested => {
        assert.deepEqual(requested, handle);
        if (options.proofUnavailable || !done || handle.bootIdentity !== processBootIdentity() || classify({ pid: handle.pid, pid_started_at: handle.pidStartedAt, hostname: handle.hostname }).state !== "dead") return false;
        try { process.kill(-handle.pgid, 0);return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }, dispose: stop };
  };
  const journal = new Proxy(workflowTurnsStore, { get(target, property) { const value = Reflect.get(target, property);return typeof value === "function" ? (...args: unknown[]) => withStoreContext(context, () => value.apply(target, args)) : value; } });
  const assemble = (selection = declaration.selection) => new SessionsWorkflowBackend({ db, declaration: { ...declaration, selection },
    enforceable: candidate => candidate.identity === scope.identity && candidate.bound === null && !Object.keys(candidate.tools).length && boundFingerprint(candidate) === boundFingerprint(scope),
    authorize: async candidate => { assert.deepEqual(candidate, scope);if (authorizationGate) { authorizationEntered.release();await authorizationGate.promise; } },authorizeTool: async () => ({ allow: false, reason: "Tool-free destination" }),prepare,
    acquire: async () => { acquiring.release();await acquireGate.promise;acquired++;return { release: () => { released++; } }; },
  });
  let backend = assemble(), turns = new WorkflowSessionTurns(journal, backend);
  return { root, key, bindingKey, scope, declaration, requests, resultText,
    get db() { return db; },get backend() { return backend; },get turns() { return turns; },
    get counts() { return { prepares, activations, acquired, released }; },
    children, closing: closing.promise, releaseClose: closeGate.release, acquiring: acquiring.promise, releaseAcquire: acquireGate.release,
    pauseAuthorization: () => { authorizationGate = gate();authorizationEntered = gate();return { entered: authorizationEntered.promise, release: authorizationGate.release }; },
    reopen: (selection?: typeof declaration.selection) => { closeSessionsDb();db = withStoreContext(context, getSessionsSqlite);backend = assemble(selection);turns = new WorkflowSessionTurns(journal, backend); },
    close: async (cleanup: { expectUnsettled?: boolean } = {}) => {
      closeGate.release();acquireGate.release();authorizationGate?.release();const failures: unknown[] = [];
      try { await backend.close();if (cleanup.expectUnsettled) failures.push(new Error("Expected durable unsettled drain refusal")); }
      catch (error) {
        const knownUncertainty = (value: unknown): boolean => value instanceof SessionReconciliationRequired || value instanceof AggregateError && value.errors.length > 0 && value.errors.every(knownUncertainty);
        if (!cleanup.expectUnsettled || !knownUncertainty(error)) failures.push(error);
        else {
          assert.ok(backend.destination.unsettled().length > 0);
          await db.backup(join(root, "uncertain-sessions.db"));
          writeFileSync(join(root, "uncertain-settlements.json"), JSON.stringify(backend.destination.unsettled()));
        }
      }
      for (const child of children) try { await child.stop(); } catch (error) { failures.push(error); }
      provider.closeAllConnections();await new Promise<void>(resolve => provider.close(() => resolve()));closeSessionsDb();
      if (previousDatabaseOverride === undefined) delete process.env.BARRY_SESSIONS_DB;else process.env.BARRY_SESSIONS_DB = previousDatabaseOverride;
      if (!failures.length && !cleanup.expectUnsettled) rmSync(root, { recursive: true, force: true });
      if (failures.length) throw new AggregateError(failures, "Destination fixture cleanup failed; retained " + root);
    } };
}

if (process.argv[2] === "harness" && process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) await harnessChild();
