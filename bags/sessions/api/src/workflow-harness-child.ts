/** Inert, one-segment harness RPC peer. Native lifetime belongs to its guardian. */
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ContinuationEffects, ContinuationHarness, RecordedCallResult, SegmentOutcome, SessionConfig, SessionEvent } from "@barry-rocks/sdk/sessions";
import type { Adapter } from "@barry-rocks/sdk/adapters/harnesses";
import { canonicalWorkflowHarnessJson, encodeWorkflowHarnessMessage, parseWorkflowHarnessMessage, workflowHarnessBindingSchema,
  workflowHarnessContinuationSchema, workflowHarnessOutcomeEnvelopeSchema, workflowHarnessOutcomeHash, workflowHarnessOutcomeSchema,
  workflowHarnessPermissionDecisionSchema, workflowHarnessPermissionRequestSchema, workflowHarnessRecordedResultSchema,
  WORKFLOW_HARNESS_MAX_BYTES, type WorkflowHarnessBinding, type WorkflowHarnessMessage } from "./workflow-harness-protocol.js";

const activateSchema = z.strictObject({ harnessId: z.string().min(1).max(200), adapterModule: z.url().refine(value => new URL(value).protocol === "file:"), config: z.object({
  sessionId: z.string().min(1), cwd: z.string().min(1), env: z.record(z.string(), z.string()), mcpServers: z.record(z.string(), z.unknown()),
}).passthrough() });
const beginSchema = z.strictObject({ content: z.string(), conversation: workflowHarnessContinuationSchema.optional() });
const restoreSchema = z.strictObject({ descriptor: workflowHarnessContinuationSchema, decisions: z.array(z.tuple([z.string().min(1), workflowHarnessPermissionDecisionSchema])).max(1000) });
const descriptorSchema = z.strictObject({ descriptor: workflowHarnessContinuationSchema });
const effectSchema = z.strictObject({ effectId: z.uuid() });
const selectSchema = activateSchema.pick({ harnessId: true, adapterModule: true });
type OpenContinuation = (config: SessionConfig, startEngine: () => Promise<never>) => Promise<ContinuationHarness>;
const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** One private spool writer. Existing different output is never replaced. */
function spoolOutcome(directory: string, binding: WorkflowHarnessBinding, outcome: SegmentOutcome): void {
  const actual = realpathSync(directory), info = statSync(actual), uid = process.getuid?.();
  if (!isAbsolute(directory) || lstatSync(directory).isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0 || uid !== undefined && info.uid !== uid) throw new Error("WorkflowHarnessSpoolUnavailable");
  const envelope = workflowHarnessOutcomeEnvelopeSchema.parse({ version: 1, binding, outcome, outcomeHash: workflowHarnessOutcomeHash(outcome) });
  const content = canonicalWorkflowHarnessJson(envelope), destination = join(actual, "result.json"), lock = join(actual, ".result-writer");
  mkdirSync(lock, { mode: 0o700 });
  const temporary = join(actual, `.result-${randomUUID()}.tmp`);
  try {
    if (existsSync(destination)) {
      const fd = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const existing = fstatSync(fd);
        if (!existing.isFile() || existing.size > WORKFLOW_HARNESS_MAX_BYTES || (existing.mode & 0o077) !== 0 || uid !== undefined && existing.uid !== uid) throw new Error("WorkflowHarnessSpoolUnavailable");
        const retained = workflowHarnessOutcomeEnvelopeSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
        if (retained.outcomeHash !== workflowHarnessOutcomeHash(retained.outcome) || canonicalWorkflowHarnessJson(retained) !== content) throw new Error("WorkflowHarnessSpoolConflict");
      } finally { closeSync(fd); }
      return;
    }
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    if (existsSync(destination)) throw new Error("WorkflowHarnessSpoolConflict");
    renameSync(temporary, destination);
    const dir = openSync(actual, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    rmdirSync(lock);
  }
}

export async function runWorkflowHarnessChild(binding: WorkflowHarnessBinding, spoolDirectory: string, registrationProbe = false): Promise<void> {
  if (!process.send || !process.connected) throw new Error("WorkflowHarnessPrivateChannelRequired");
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const closures = new Map<string, () => Promise<RecordedCallResult>>();
  const seen = new Set<string>();
  let harness: ContinuationHarness | undefined, activation: Promise<void> | undefined, active: Promise<SegmentOutcome> | undefined;
  let selected: { harnessId: string; adapterModule: string; open: OpenContinuation } | undefined;
  let closing = false, disconnected = false, delivered = false;
  const rejectPending = () => { for (const item of pending.values()) item.reject(new Error("WorkflowHarnessClosed")); pending.clear(); closures.clear(); };
  const send = async (message: WorkflowHarnessMessage): Promise<void> => {
    if (disconnected || !process.connected) throw new Error("WorkflowHarnessClosed");
    const object = JSON.parse(encodeWorkflowHarnessMessage(message)) as WorkflowHarnessMessage;
    await new Promise<void>((done, reject) => process.send!(object, undefined, undefined, error => error ? reject(new Error("WorkflowHarnessChannelUnavailable")) : done()));
  };
  const rpc = async (method: string, value: unknown): Promise<unknown> => {
    if (closing || pending.size >= 1024) throw new Error("WorkflowHarnessClosed");
    const id = randomUUID();
    return new Promise<unknown>((done, reject) => {
      pending.set(id, { resolve: done, reject });
      void send({ version: 1, binding, id, kind: "request", method, value: normalize(value) }).catch(() => { pending.delete(id); reject(new Error("WorkflowHarnessChannelUnavailable")); });
    });
  };
  const effects: ContinuationEffects = {
    authorize: async call => workflowHarnessPermissionDecisionSchema.parse(await rpc("authorize", workflowHarnessPermissionRequestSchema.parse(call))),
    recorded: async call => {
      const result = await rpc("recorded", workflowHarnessPermissionRequestSchema.parse(call));
      return result === undefined ? undefined : workflowHarnessRecordedResultSchema.parse(result);
    },
    denied: async (call, result) => workflowHarnessRecordedResultSchema.parse(await rpc("denied", { call: workflowHarnessPermissionRequestSchema.parse(call), result: workflowHarnessRecordedResultSchema.parse(normalize(result)) })),
    execute: async (call, effect) => {
      const effectId = randomUUID(); closures.set(effectId, effect);
      try { return workflowHarnessRecordedResultSchema.parse(await rpc("execute", { call: workflowHarnessPermissionRequestSchema.parse(call), effectId })); }
      finally { closures.delete(effectId); }
    },
  };
  const emit = async (event: SessionEvent) => {
    const safe = event.type === "error" || event.type === "result" && event.error
      ? { ...event, error: "WorkflowHarnessExecutionFailed" } : event;
    await rpc("event", normalize(safe));
  };
  const requireHarness = () => { if (!harness || closing) throw new Error("WorkflowHarnessNotActive"); return harness; };
  const run = async (operation: () => Promise<SegmentOutcome>) => {
    if (active || delivered || closing) throw new Error("WorkflowHarnessInputAlreadyDelivered");
    delivered = true;
    active = operation();
    try {
      const raw = await active;
      if (closing) throw new Error("WorkflowHarnessClosed");
      const outcome = workflowHarnessOutcomeSchema.parse(normalize(raw.type === "failed" ? { type: "failed", error: "WorkflowHarnessExecutionFailed" } : raw));
      spoolOutcome(spoolDirectory, binding, outcome);
      return outcome;
    } finally { active = undefined; }
  };
  const dispatch = async (method: string, value: unknown): Promise<unknown> => {
    if (method === "close") {
      closing = true; rejectPending();
      await activation?.catch(() => {});
      await harness?.close();
      return undefined;
    }
    if (closing) throw new Error("WorkflowHarnessClosed");
    // Registration has no activation/configuration/input surface. Its only
    // application import is an inert inspection of this retained generation.
    if (registrationProbe && method !== "inspect") throw new Error("WorkflowHarnessRegistrationOnly");
    if (method === "inspect") {
      if (!registrationProbe || !process.env.BARRY_WORKFLOW_CLOSURE_SHA256) throw new Error("WorkflowHarnessRegistrationOnly");
      const request = selectSchema.parse(value);
      const loaded = await import(request.adapterModule) as { default: Adapter; vendorCode?: unknown; vendorFactories?: unknown };
      if (loaded.default?.id !== request.harnessId) throw new Error("WorkflowHarnessSelectionConflict");
      if (loaded.vendorCode !== undefined || loaded.vendorFactories !== undefined) throw new Error("WorkflowRuntimeVendorCodeUnsupported");
      const { retainedWorkflowDeclaration } = await import("./workflow-runtime-registration-contract.js");
      return retainedWorkflowDeclaration(loaded.default, request.adapterModule);
    }
    if (method === "select") {
      if (!process.env.BARRY_WORKFLOW_CLOSURE_SHA256 || activation || harness) throw new Error("WorkflowHarnessSelectionConflict");
      const request = selectSchema.parse(value);
      if (selected && (selected.harnessId !== request.harnessId || selected.adapterModule !== request.adapterModule)) throw new Error("WorkflowHarnessSelectionConflict");
      if (!selected) {
        const loaded = await import(request.adapterModule) as { default?: { id?: string; modes?: { hosted?: { openContinuation?: OpenContinuation; approvalContinuation?: string } } } };
        if (loaded.default?.id !== request.harnessId || loaded.default.modes?.hosted?.approvalContinuation !== "durable" || typeof loaded.default.modes.hosted.openContinuation !== "function") throw new Error("WorkflowHarnessSelectionConflict");
        selected = { ...request, open: loaded.default.modes.hosted.openContinuation };
      }
      return { approvalContinuation: "durable" };
    }
    if (method === "activate") {
      if (activation || harness) throw new Error("WorkflowHarnessAlreadyActive");
      const request = activateSchema.parse(value);
      if (request.config.sessionId !== binding.sessionId) throw new Error("WorkflowHarnessBindingConflict");
      if (process.env.BARRY_WORKFLOW_CLOSURE_SHA256 && (!selected || selected.harnessId !== request.harnessId || selected.adapterModule !== request.adapterModule)) throw new Error("WorkflowHarnessSelectionConflict");
      activation = (async () => {
        const loaded = selected ? undefined : await import(request.adapterModule) as { default?: { id?: string; modes?: { hosted?: { openContinuation?: OpenContinuation } } } };
        if (!selected && loaded?.default?.id !== request.harnessId) throw new Error("WorkflowHarnessSelectionConflict");
        const open = selected?.open ?? loaded?.default?.modes?.hosted?.openContinuation;
        if (!open) throw new Error("WorkflowHarnessUnsupported");
        const candidate = await open({ ...request.config, decide: effects.authorize } as SessionConfig, async () => { throw new Error("WorkflowHarnessNestedEngineForbidden"); });
        if (closing || candidate.approvalContinuation !== "durable") { await candidate.close(); throw new Error("WorkflowHarnessUnsupported"); }
        harness = candidate;
      })();
      await activation; return { approvalContinuation: "durable" };
    }
    if (method === "interrupt") { await harness?.interrupt(); return undefined; }
    if (method === "effect") {
      const { effectId } = effectSchema.parse(value), effect = closures.get(effectId);
      if (!effect) throw new Error("WorkflowHarnessEffectUnavailable");
      closures.delete(effectId);
      return workflowHarnessRecordedResultSchema.parse(normalize(await effect()));
    }
    if (method === "validate") { const { descriptor } = descriptorSchema.parse(value); requireHarness().validate(descriptor); return undefined; }
    if (method === "begin") {
      const request = beginSchema.parse(value), current = requireHarness();
      return run(() => current.begin(request.content, emit, request.conversation));
    }
    if (method === "restore") {
      const request = restoreSchema.parse(value), current = requireHarness(), decisions = new Map(request.decisions);
      if (decisions.size !== request.decisions.length) throw new Error("WorkflowHarnessDecisionConflict");
      return run(() => {
        current.validate(request.descriptor);
        return current.restore(request.descriptor, decisions, effects, emit);
      });
    }
    throw new Error("WorkflowHarnessMethodUnavailable");
  };
  const disconnect = () => { disconnected = true; closing = true; rejectPending(); void harness?.interrupt().catch(() => {}); };
  process.once("disconnect", disconnect);
  process.on("message", value => {
    void (async () => {
      let message: WorkflowHarnessMessage;
      try { message = parseWorkflowHarnessMessage(value, binding); }
      catch { disconnect(); process.exitCode = 1; process.disconnect?.(); return; }
      if (message.kind === "response") {
        const waiter = pending.get(message.id); if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error("WorkflowHarnessParentRequestFailed")); else waiter.resolve(message.value);
        return;
      }
      if (message.kind !== "request") { disconnect(); process.exitCode = 1; process.disconnect?.(); return; }
      if (seen.has(message.id) || seen.size >= 10000) {
        await send({ version: 1, binding, id: message.id, kind: "response", error: "WorkflowHarnessProtocolError" }); return;
      }
      seen.add(message.id);
      try {
        const result = await dispatch(message.method, message.value);
        await send({ version: 1, binding, id: message.id, kind: "response", ...(result === undefined ? {} : { value: normalize(result) }) });
        if (message.method === "close") { process.disconnect?.(); process.exit(0); }
      } catch {
        await send({ version: 1, binding, id: message.id, kind: "response", error: "WorkflowHarnessRequestFailed" }).catch(() => {});
        if (message.method === "close") { process.disconnect?.(); process.exit(1); }
      }
    })().catch(() => { disconnect(); process.exitCode = 1; if (process.connected) process.disconnect?.(); });
  });
  await send({ version: 1, binding, id: randomUUID(), kind: "ready", ...(process.env.BARRY_WORKFLOW_CLOSURE_SHA256 ? { runtimeDigest: process.env.BARRY_WORKFLOW_CLOSURE_SHA256 } : {}) });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) && process.argv[2] && process.argv[3]) {
  try { await runWorkflowHarnessChild(workflowHarnessBindingSchema.parse(JSON.parse(process.argv[2])), process.argv[3], process.argv[4] === "--registration-probe"); }
  catch { process.exitCode = 1; }
}
