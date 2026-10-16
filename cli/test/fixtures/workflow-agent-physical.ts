/** Physical-recovery composition: real SQLite, Pi and production worker; trusted fixture policy, no broker claim. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { approveWorkflowBounds, boundFingerprint } from "@barry-rocks/sdk/bounds";
import { WorkflowSessionTurns, workflowSessionId, SessionReconciliationRequired } from "@barry-rocks/sdk/internal/sessions";
import { bootstrapStoreGeneration, withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import { closeSessionsDb, getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { SessionsWorkflowBackend, type WorkflowHarnessLaunch } from "../../../bags/sessions/api/src/workflow-session-backend.js";
import { prepareWorkflowProcessHarness, inspectWorkflowHarnessOutcome } from "../../../bags/sessions/api/src/workflow-process-harness.js";
import type { WorkflowDestinationBinding } from "@barry-rocks/sessions-bag/store/workflow-destinations";

const self = fileURLToPath(import.meta.url), loader = import.meta.resolve("tsx");
const adapterModule = new URL("../../../adapters/sessions/pi/src/adapter.ts", import.meta.url).href;
const workerEntrypoint = fileURLToPath(new URL("../../../bags/sessions/api/src/workflow-harness-child.ts", import.meta.url));
const finalResult = "recovered actual Pi result", toolContent = "exact-original-native-write\n", callId = "original-write-call";
function guard(root: string): void { assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()));assert.match(basename(root), /^workflow-agent-physical-[A-Za-z0-9]+$/); }
function deferred() { let resolve!: () => void;const promise = new Promise<void>(done => { resolve = done; });return { promise, resolve }; }
function spoolBindings(root: string): { directory: string; binding: { sessionId: string; turnId: string; segmentId: string; owner: string } }[] {
  return readdirSync(root).map(name => ({ directory: join(root, name), binding: JSON.parse(readFileSync(join(root, name, "binding.json"), "utf8")) }));
}
function assemble(root: string, declaration: WorkflowDestinationBinding, key: string, options: { outcomeGate?: "completed" | "interrupted"; disconnectReply?: boolean; holdEffect?: boolean } = {}) {
  guard(root);const context = { identity: declaration.identity };
  let db = withStoreContext(context, getSessionsSqlite);
  const launches: WorkflowHarnessLaunch[] = [], configured: string[] = [], policyChecks: boolean[] = [], driverPolicyChecks: boolean[] = [];
  let permitted = true;
  const authorize = async () => { policyChecks.push(permitted);assert.ok(permitted, "Current trusted fixture authority revoked");assert.equal(declaration.scope.identity, context.identity);assert.ok(Date.now() < declaration.selection.deadline); };
  const make = () => new SessionsWorkflowBackend({ db, declaration,
    recovery: { spoolRoot: join(root, "spool") },
    enforceable: scope => boundFingerprint(scope) === boundFingerprint(declaration.scope),authorize,
    authorizeTool: async (_scope, call) => {
      const input = call.input as { path?: unknown; content?: unknown } | null;
      if (call.tool !== "write" || !input || input.path !== join(root, "native-effect.txt") || input.content !== toolContent || Object.keys(input).length !== 2) return { allow: false, reason: "Outside exact fixture native allowance" };
      return { allow: true };
    },
    prepare: async launch => {
      launches.push(launch);
      return prepareWorkflowProcessHarness({ harnessId: "pi", adapterModule, workerEntrypoint, nodeArgs: ["--import", loader, ...(options.outcomeGate || options.holdEffect ? ["--import", new URL("./workflow-agent-physical-gate.ts", import.meta.url).href] : [])], spoolRoot: join(root, "spool"),
        inertEnvironment: { PATH: process.env.PATH ?? "", HOME: root, BARRY_HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "pi"), TMPDIR: tmpdir() },
        authorize: async () => { driverPolicyChecks.push(permitted);await authorize(); },
        configure: async candidate => {
          const fence = db.prepare("SELECT phase,handle_json FROM session_workflow_settlements WHERE segment_id=?").get(candidate.segmentId) as { phase: string; handle_json: string };
          assert.equal(fence.phase, "handled");assert.ok(JSON.parse(fence.handle_json).pid);configured.push(candidate.segmentId);
          return { sessionId: candidate.sessionId, cwd: root, model: "openai/probe", endpoint: { baseUrl: declaration.selection.endpoint!, apiKey: "supervised-local-key" },
            env: { HOME: root, PATH: process.env.PATH ?? "" }, mcpServers: {}, allowedNativeTools: ["write"] };
        },
      }, launch);
    },
  });
  const journal = new Proxy(workflowTurnsStore, { get(target, property) { const value = Reflect.get(target, property);return typeof value === "function" ? (...args: unknown[]) => withStoreContext(context, () => value.apply(target, args)) : value; } });
  let backend = make(), turns = new WorkflowSessionTurns(journal, backend);
  return { get db() { return db; },get backend() { return backend; },get turns() { return turns; },launches, configured, policyChecks,driverPolicyChecks,revoke: () => { permitted = false; },
    reopen: () => { closeSessionsDb();db = withStoreContext(context, getSessionsSqlite);backend = make();turns = new WorkflowSessionTurns(journal, backend); },
    markUncertain: () => withStoreContext(context, () => workflowTurnsStore.updateTurn(key, "uncertain")),
    start: async () => { const id = await turns.ensure(declaration.bindingKey, declaration.scope);return turns.turn(key, id, { text: "one original supervised request" }, declaration.scope); },
  };
}

export async function workflowAgentPhysical(options: { mode?: "tool" | "blocked" | "spool-failure"; deadlineMs?: number; outcomeGate?: "completed" | "interrupted"; disconnectReply?: boolean; holdEffect?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-agent-physical-")));guard(root);
  mkdirSync(join(root, "home"), { mode: 0o700 });mkdirSync(join(root, "spool"), { mode: 0o700 });
  const saved = { home: process.env.BARRY_HOME, db: process.env.BARRY_SESSIONS_DB };
  closeSessionsDb();process.env.BARRY_HOME = join(root, "home");delete process.env.BARRY_SESSIONS_DB;bootstrapStoreGeneration(barryStoresDir());
  const identity = randomUUID(), bindingKey = "recovery/" + randomUUID(), key = bindingKey + "/turn";
  const base = await approveWorkflowBounds({ identity, bags: [], tools: [], boundByName: async () => undefined });
  const { fingerprint: _fingerprint, ...original } = base;
  const evidence = { ...original, tools: { "pi:write": "write" as const }, contracts: { "pi:write": boundFingerprint({ fixture: "actual Pi native write exact original path/content" }) } };
  const scope = { ...evidence, fingerprint: boundFingerprint(evidence) }, mode = options.mode ?? "tool";
  const providerErrors: string[] = [];
  const requested = deferred(), requests: { body: unknown; phase: string; handle: unknown; authorization: string | undefined }[] = [];
  const provider = createServer((req, res) => {
    let raw = "";req.on("data", chunk => { raw += String(chunk); });req.on("end", () => {
      try {
        assert.equal(req.headers.authorization, "Bearer supervised-local-key");
        const body = JSON.parse(raw), row = active!.db.prepare("SELECT phase,handle_json FROM session_workflow_settlements ORDER BY rowid DESC LIMIT 1").get() as { phase: string; handle_json: string };
        assert.equal(row.phase, "input");requests.push({ body, phase: row.phase, handle: JSON.parse(row.handle_json), authorization: req.headers.authorization });requested.resolve();
        if (mode === "blocked") return;
        if (mode === "spool-failure") {
          const prepared = spoolBindings(join(root, "spool"));assert.equal(prepared.length, 1);
          mkdirSync(join(prepared[0].directory, "result.json"), { mode: 0o700 });
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "supervised", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (mode === "tool" && requests.length === 1) {
          assert.equal(existsSync(join(root, "native-effect.txt")), false);
          const tools = body.tools as { function?: { name?: string } }[];assert.ok(tools.some(tool => tool.function?.name === "write"));
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "write", arguments: JSON.stringify({ path: join(root, "native-effect.txt"), content: toolContent }) } }] }, null);chunk({}, "tool_calls");
        } else { chunk({ role: "assistant", content: finalResult }, null);chunk({}, "stop"); }
        res.end("data: [DONE]\n\n");
      } catch (error) { providerErrors.push(error instanceof Error ? error.stack ?? error.message : String(error));if (!res.headersSent) res.writeHead(500);res.end("Local fixture provider refused the request"); }
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  const declaration: WorkflowDestinationBinding = { bindingKey, sessionId: workflowSessionId(bindingKey, identity), identity, identityId: 42, actorId: 1, scope,
    selection: { harness: "pi", model: "openai/probe", endpoint, cwd: root, maxTurns: 4, deadline: Date.now() + (options.deadlineMs ?? 45000) } };
  writeFileSync(join(root, "recovery-gate.json"), JSON.stringify({ outcome: options.outcomeGate, disconnect: options.disconnectReply ?? false, holdEffect: options.holdEffect ?? false, effect: { id: callId, path: join(root, "native-effect.txt"), content: toolContent } }), { mode: 0o600 });
  const active = assemble(root, declaration, key, options);
  writeFileSync(join(root, "fixture.json"), JSON.stringify({ declaration, key, options }), { mode: 0o600 });
  const ownedParents: { child: ChildProcess; closed: Promise<void> }[] = [];
  return { root, key, declaration, scope, requests, providerErrors, finalResult, toolContent, callId, requested: requested.promise,
    get db() { return active!.db; },get backend() { return active!.backend; },get turns() { return active!.turns; },get launches() { return active!.launches; },get configured() { return active!.configured; },get policyChecks() { return active!.policyChecks; },get driverPolicyChecks() { return active!.driverPolicyChecks; },
    revoke: () => active!.revoke(),
    effectMarker: () => existsSync(join(root, "effect-pending.json")) ? JSON.parse(readFileSync(join(root, "effect-pending.json"), "utf8")) as { binding: { sessionId: string; turnId: string; segmentId: string; owner: string }; pid: number; effectId: string } : undefined,
    marker: () => existsSync(join(root, "outcome-committed.json")) ? JSON.parse(readFileSync(join(root, "outcome-committed.json"), "utf8")) as { binding: { sessionId: string; turnId: string; segmentId: string; owner: string }; pid: number; type: string } : undefined,
    start: () => active!.start(),markUncertain: () => active!.markUncertain(),reopen: () => active!.reopen(),
    outcomes: () => spoolBindings(join(root, "spool")).map(entry => ({ ...entry, outcome: inspectWorkflowHarnessOutcome(join(root, "spool"), entry.binding) })),
    clearSpoolObstruction: () => { for (const entry of spoolBindings(join(root, "spool"))) rmSync(join(entry.directory, "result.json"), { recursive: true, force: true }); },
    startParent: async () => {
      const child = spawn(process.execPath, ["--import", loader, self, "owner", root], { env: { PATH: process.env.PATH, TMPDIR: tmpdir(), BARRY_HOME: join(root, "home") }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let stderr = "";child.stderr!.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-16000); });
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));ownedParents.push({ child, closed });
      let failureTimer: ReturnType<typeof setTimeout> | undefined;
      const failed = new Promise<never>((_resolve, reject) => {
        const refuse = (message: string) => { clearTimeout(failureTimer);reject(new Error(message + "; owner stderr: " + stderr)); };
        child.on("message", value => {
          if (value && typeof value === "object" && "failed" in value && value.failed === true) refuse("Actual supervised owner startup failed: " + JSON.stringify(value));
        });
        child.once("close", () => refuse("Supervised owner closed before provider readiness"));
        failureTimer = setTimeout(() => refuse("Supervised owner did not reach provider readiness before its original deadline and cleanup bound"), Math.max(1, declaration.selection.deadline - Date.now() + 7500));
        failureTimer.unref();
      });
      // Rejection can precede the caller's readiness race or follow intentional
      // SIGKILL. Keep it handled without replacing the actual failure evidence.
      void failed.catch(() => {});void requested.promise.then(() => clearTimeout(failureTimer));
      await Promise.race([new Promise<void>(resolve => child.on("message", value => { if (value && typeof value === "object" && "started" in value && value.started === true) resolve(); })), failed]);
      return { child, closed, failed };
    },
    close: async (options: { expectUnsettled?: boolean } = {}) => {
      const failures: unknown[] = [];
      for (const parent of ownedParents) { if (parent.child.exitCode === null && parent.child.signalCode === null) parent.child.kill("SIGKILL");await parent.closed; }
      try { await active!.backend.close();if (options.expectUnsettled) failures.push(new Error("Expected conservative unsettled drain rejection")); }
      catch (error) {
        const uncertain = (value: unknown): boolean => value instanceof SessionReconciliationRequired || value instanceof AggregateError && value.errors.length > 0 && value.errors.every(uncertain);
        if (!options.expectUnsettled || !uncertain(error)) failures.push(error);
        else { await active!.db.backup(join(root, "uncertain-sessions.db"));writeFileSync(join(root, "uncertain-settlements.json"), JSON.stringify(active!.backend.destination.unsettled())); }
      }
      provider.closeAllConnections();await new Promise<void>(resolve => provider.close(() => resolve()));closeSessionsDb();
      if (saved.home === undefined) delete process.env.BARRY_HOME;else process.env.BARRY_HOME = saved.home;
      if (saved.db === undefined) delete process.env.BARRY_SESSIONS_DB;else process.env.BARRY_SESSIONS_DB = saved.db;
      if (!failures.length && !options.expectUnsettled) rmSync(root, { recursive: true, force: true });
      if (failures.length) throw new AggregateError(failures, "Supervised fixture cleanup failed; retained " + root);
    },
  };
}

if (process.argv[2] === "owner" && process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  const root = realpathSync(process.argv[3]);guard(root);assert.equal(realpathSync(process.env.BARRY_HOME!), join(root, "home"));
  const { declaration, key, options } = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")) as { declaration: WorkflowDestinationBinding; key: string; options: { outcomeGate?: "completed" | "interrupted"; disconnectReply?: boolean; holdEffect?: boolean } };
  const actual = assemble(root, declaration, key, options);
  await new Promise<void>((resolve, reject) => process.send!({ started: true }, (error: Error | null) => error ? reject(error) : resolve()));
  void actual.start().catch(async error => {
    const diagnostic = { failed: true, error: error instanceof Error ? error.message : String(error),
      turns: actual.db.prepare("SELECT id,state,error FROM session_turns").all(),
      settlements: actual.db.prepare("SELECT segment_id,phase,handle_json,input_at,ceased_at FROM session_workflow_settlements").all() };
    await new Promise<void>((resolve, reject) => process.send!(diagnostic, (sendError: Error | null) => sendError ? reject(sendError) : resolve()))
      .catch(sendError => { process.stderr.write("Owner failure diagnostic delivery failed: " + String(sendError)); });
  });
  setInterval(() => {}, 1000);
}
