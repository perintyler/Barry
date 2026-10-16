/** Sessions' one-segment native harness driver. Trusted host composition only. */
import { randomUUID, createHash } from "node:crypto";
import { constants, openSync, closeSync, readFileSync, writeFileSync, fstatSync, fsyncSync, lstatSync, realpathSync, mkdirSync, statSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { prepareOwnedProcess, type WorkArtifactStore } from "@barry-rocks/sdk/internal/workflows";
import { SessionReconciliationRequired } from "@barry-rocks/sdk/internal/sessions";
import type { ContinuationEffects, ContinuationHarness, ContinuationDescriptor, SessionConfig, SessionEvent, SegmentOutcome } from "@barry-rocks/sdk/sessions";
import type { PreparedWorkflowHarness, WorkflowHarnessLaunch } from "./workflow-session-backend.js";
import { materializeWorkflowRuntimeCooperatively, workflowRuntimeReferenceSchema, type WorkflowRuntimeReference } from "./workflow-runtime-closure.js";
import { canonicalWorkflowHarnessJson, encodeWorkflowHarnessMessage, parseWorkflowHarnessMessage,
  workflowHarnessBindingSchema, workflowHarnessContinuationSchema, workflowHarnessOutcomeEnvelopeSchema, workflowHarnessOutcomeHash,
  workflowHarnessOutcomeSchema, workflowHarnessPermissionRequestSchema, workflowHarnessRecordedResultSchema,
  WORKFLOW_HARNESS_MAX_BYTES, type WorkflowHarnessBinding, type WorkflowHarnessMessage } from "./workflow-harness-protocol.js";

interface WorkflowProcessHarnessCommon {
  harnessId: string;
  spoolRoot: string;
  inertEnvironment: Record<string, string>;
  /** Actual retained/current policy check after asynchronous credential selection too. */
  authorize(launch: WorkflowHarnessLaunch): Promise<void>;
  configure(launch: WorkflowHarnessLaunch): Promise<SessionConfig>;
}
/** A closure-bound destination can never fall back to legacy installed paths.
 * Legacy options remain solely for the preexisting execution generation. */
export type WorkflowProcessHarnessOptions = WorkflowProcessHarnessCommon & (
  { runtime: { artifacts: WorkArtifactStore; reference: WorkflowRuntimeReference }; adapterModule?: never; workerEntrypoint?: never; nodeArgs?: never } |
  { runtime?: undefined; adapterModule: string; workerEntrypoint: string; nodeArgs?: string[] }
);
const deniedSchema = z.strictObject({ call: workflowHarnessPermissionRequestSchema, result: workflowHarnessRecordedResultSchema });
const executeSchema = z.strictObject({ call: workflowHarnessPermissionRequestSchema, effectId: z.uuid() });
const inertNames = new Set(["PATH", "HOME", "BARRY_HOME", "PI_CODING_AGENT_DIR", "TMPDIR", "NODE_NO_WARNINGS"]);
async function beforeDeadline<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SessionReconciliationRequired();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
      const expire = () => {
        const left = deadline - Date.now();
        if (left <= 0) reject(new SessionReconciliationRequired());
        else timer = setTimeout(expire, Math.min(left, 2_147_483_647));
      };
      expire();
    })]);
  } finally { clearTimeout(timer); }
}
const bindingFor = (launch: WorkflowHarnessLaunch): WorkflowHarnessBinding => workflowHarnessBindingSchema.parse({
  sessionId: launch.sessionId, turnId: launch.turnId, segmentId: launch.segmentId, owner: launch.owner,
});
// Only this module can attest that a fresh preparation never invoked native
// ownership. Persisted/deserialized exceptions cannot acquire this brand.
const preparationRefusals = new WeakMap<object, string>();
export function workflowHarnessPreparationRefusal(error: unknown, launch: WorkflowHarnessLaunch): boolean {
  return error !== null && typeof error === "object" && preparationRefusals.get(error) === canonicalWorkflowHarnessJson(launch);
}
function privateDirectory(path: string): string {
  if (!isAbsolute(path) || lstatSync(path).isSymbolicLink()) throw new Error("Workflow harness spool is unavailable");
  const canonical = realpathSync(path), info = statSync(canonical);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new Error("Workflow harness spool is unavailable");
  return canonical;
}
function segmentDirectory(root: string, binding: WorkflowHarnessBinding): string {
  return join(privateDirectory(root), createHash("sha256").update(canonicalWorkflowHarnessJson(binding)).digest("hex"));
}

/** Read retained output only; never launches, signals a stored PID, or marks cessation. */
export function inspectWorkflowHarnessOutcome(root: string, binding: WorkflowHarnessBinding): SegmentOutcome | undefined {
  const directory = segmentDirectory(root, workflowHarnessBindingSchema.parse(binding));
  let fd: number;
  try { privateDirectory(directory);fd = openSync(join(directory, "result.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;throw error; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > WORKFLOW_HARNESS_MAX_BYTES || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new Error("Workflow harness result is unavailable");
    const envelope = workflowHarnessOutcomeEnvelopeSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    if (canonicalWorkflowHarnessJson(envelope.binding) !== canonicalWorkflowHarnessJson(binding) || envelope.outcomeHash !== workflowHarnessOutcomeHash(envelope.outcome)) throw new Error("Workflow harness result binding conflict");
    return envelope.outcome;
  } finally { closeSync(fd); }
}

export async function prepareWorkflowProcessHarness(options: WorkflowProcessHarnessOptions, originalLaunch: WorkflowHarnessLaunch): Promise<PreparedWorkflowHarness> {
  // Selection and the inert process environment must not follow caller mutation
  // across asynchronous policy/configuration callbacks.
  options = { ...options, inertEnvironment: { ...options.inertEnvironment }, ...(options.runtime
    ? { runtime: { artifacts: options.runtime.artifacts, reference: structuredClone(options.runtime.reference) } }
    : { nodeArgs: [...(options.nodeArgs ?? [])] }) } as WorkflowProcessHarnessOptions;
  const launch = structuredClone(originalLaunch), binding = bindingFor(launch);
  if (options.harnessId !== launch.declaration.selection.harness
    || Object.keys(options.inertEnvironment).some(name => !inertNames.has(name)) || Object.values(options.inertEnvironment).some(value => typeof value !== "string")) throw new Error("Workflow harness selection is unavailable");
  const acceptedRuntime = launch.declaration.selection.runtime;
  if (options.runtime) {
    if (!acceptedRuntime || canonicalWorkflowHarnessJson(workflowRuntimeReferenceSchema.parse(acceptedRuntime)) !== canonicalWorkflowHarnessJson(workflowRuntimeReferenceSchema.parse(options.runtime.reference))) throw new Error("Workflow harness runtime selection changed");
  } else if (acceptedRuntime || new URL(options.adapterModule).protocol !== "file:" || !isAbsolute(options.workerEntrypoint)) throw new Error("Workflow harness runtime selection is unavailable");
  await beforeDeadline(launch.declaration.selection.deadline, () => options.authorize(structuredClone(launch)));
  const directory = segmentDirectory(options.spoolRoot, binding);
  // An existing preparation is evidence, never permission to start a replacement.
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch { throw new SessionReconciliationRequired(); }
  const fresh = lstatSync(directory);
  if (!fresh.isDirectory() || fresh.isSymbolicLink() || realpathSync(directory) !== directory) throw new SessionReconciliationRequired();
  const snapshotDirectory = join(directory, "runtime");
  let retained: Awaited<ReturnType<typeof materializeWorkflowRuntimeCooperatively>> | undefined;
  let bindingIdentity: { dev: number; ino: number } | undefined;
  try {
    const record = openSync(join(directory, "binding.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { bindingIdentity = fstatSync(record);writeFileSync(record, canonicalWorkflowHarnessJson(binding));fsyncSync(record); } finally { closeSync(record); }
    const folder = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(folder); } finally { closeSync(folder); }
    const parentFolder = openSync(privateDirectory(options.spoolRoot), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parentFolder); } finally { closeSync(parentFolder); }
    if (options.runtime) retained = await materializeWorkflowRuntimeCooperatively(options.runtime.artifacts, options.runtime.reference, options.harnessId, snapshotDirectory);
    // Copying now yields to Stop/deadlines. Recheck their actual authority
    // before invoking native ownership, even when all source bytes verified.
    await beforeDeadline(launch.declaration.selection.deadline, () => options.authorize(structuredClone(launch)));
  } catch (cause) {
    // A prior directory or an identity change is evidence of uncertainty. Only
    // our fresh, unchanged binding can positively exclude a native invocation.
    try {
      const current = lstatSync(directory);
      if (current.dev !== fresh.dev || current.ino !== fresh.ino || !current.isDirectory() || current.isSymbolicLink()
        || current.uid !== fresh.uid || realpathSync(directory) !== directory || (current.mode & 0o077) !== 0 || !bindingIdentity) throw cause;
      const proofRecord = openSync(join(directory, "binding.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(proofRecord);
        if (!info.isFile() || info.dev !== bindingIdentity.dev || info.ino !== bindingIdentity.ino || info.nlink !== 1 || info.uid !== fresh.uid || (info.mode & 0o077) !== 0
          || info.size !== Buffer.byteLength(canonicalWorkflowHarnessJson(binding))
          || readFileSync(proofRecord, "utf8") !== canonicalWorkflowHarnessJson(binding)) throw cause;
      } finally { closeSync(proofRecord); }
    } catch { throw cause; }
    const refusal = new Error("Workflow harness preparation refused before native invocation", { cause });
    refusal.name = "WorkflowHarnessPreparationRefused";
    preparationRefusals.set(refusal, canonicalWorkflowHarnessJson(launch));
    throw refusal;
  }
  // Neither synchronous throws nor rejected promises from this call may be
  // branded above: native preparation may already have created a guardian.
  const owned = await prepareOwnedProcess({ deadline: launch.declaration.selection.deadline, ...(retained ? { runtime: retained.runtime, bootstrap: retained.guardian } : {}) });
  let ready!: () => void, rejectReady!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => { ready = resolve;rejectReady = reject; });
  // Readiness can reject before activation starts awaiting it.
  void readiness.catch(() => {});
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const seen = new Set<string>();
  let effects: ContinuationEffects | undefined, emit: ((event: SessionEvent) => Promise<void>) | undefined;
  let activated = false, delivered = false, closing = false;
  const send = (message: WorkflowHarnessMessage) => owned.send(JSON.parse(encodeWorkflowHarnessMessage(message)));
  const rpc = (method: string, value?: unknown): Promise<unknown> => {
    if (pending.size >= 1024) return Promise.reject(new SessionReconciliationRequired());
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void send({ version: 1, binding, id, kind: "request", method, ...(value === undefined ? {} : { value }) }).catch(() => {
        pending.delete(id);reject(new SessionReconciliationRequired());
      });
    });
  };
  void owned.closed.then(() => {
    rejectReady(new SessionReconciliationRequired());
    for (const item of pending.values()) item.reject(new SessionReconciliationRequired());pending.clear();
  });
  const receive = async (raw: unknown) => {
    const message = parseWorkflowHarnessMessage(raw, binding);
    if (message.kind === "ready") {
      if (message.runtimeDigest !== acceptedRuntime?.digest) throw new SessionReconciliationRequired();
      ready();return;
    }
    if (message.kind === "response") {
      const item = pending.get(message.id);if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(new SessionReconciliationRequired());else item.resolve(message.value);
      return;
    }
    if (seen.has(message.id) || seen.size >= 10000) throw new SessionReconciliationRequired();
    seen.add(message.id);
    try {
      let value: unknown;
      if (closing) throw new SessionReconciliationRequired();
      if (message.method === "event") {
        if (!emit) throw new SessionReconciliationRequired();
        await emit(message.value as SessionEvent);
      } else {
        if (!effects) throw new SessionReconciliationRequired();
        if (message.method === "authorize") value = await effects.authorize(workflowHarnessPermissionRequestSchema.parse(message.value));
        else if (message.method === "recorded") value = await effects.recorded?.(workflowHarnessPermissionRequestSchema.parse(message.value));
        else if (message.method === "denied") {
          const request = deniedSchema.parse(message.value);
          if (!effects.denied) throw new SessionReconciliationRequired();
          value = await effects.denied(request.call, request.result);
        } else if (message.method === "execute") {
          const request = executeSchema.parse(message.value);
          value = await effects.execute(request.call, async () => workflowHarnessRecordedResultSchema.parse(await rpc("effect", { effectId: request.effectId })));
        } else throw new SessionReconciliationRequired();
      }
      await send({ version: 1, binding, id: message.id, kind: "response", ...(value === undefined ? {} : { value }) });
    } catch { await send({ version: 1, binding, id: message.id, kind: "response", error: "WorkflowHarnessParentRequestFailed" }); }
  };
  const unsubscribe = owned.onMessage(value => { void receive(value).catch(() => { void owned.stop().catch(() => {}); }); });
  const quiesce = async () => {
    closing = true;
    if (activated) void rpc("close").catch(() => {});
    try { await owned.dispose();unsubscribe();if (retained) rmSync(snapshotDirectory, { recursive: true, force: true }); }
    catch { throw new SessionReconciliationRequired(); }
  };
  const run = async (method: string, value: unknown, callback: (event: SessionEvent) => Promise<void>, executor?: ContinuationEffects): Promise<SegmentOutcome> => {
    if (!activated || closing || delivered) throw new SessionReconciliationRequired();
    delivered = true;emit = callback;effects = executor;
    let response: unknown;
    try { response = await rpc(method, value); }
    catch {
      // The child commits its result before replying. A lost reply must never
      // resend input: stop the process we still own, prove cessation, then read.
      await quiesce();
      if (!await owned.proveCessation()) throw new SessionReconciliationRequired();
      const retained = inspectWorkflowHarnessOutcome(options.spoolRoot, binding);
      // Returning a recovered checkpoint here would let TurnExecution's normal
      // automatic policy dispatch another segment. Leave it for metadata-only
      // dead-owner recovery instead; terminal output cannot dispatch effects.
      if (!retained || retained.type === "interrupted") throw new SessionReconciliationRequired();
      return retained;
    }
    const outcome = workflowHarnessOutcomeSchema.parse(response);
    const retained = inspectWorkflowHarnessOutcome(options.spoolRoot, binding);
    if (!retained || canonicalWorkflowHarnessJson(retained) !== canonicalWorkflowHarnessJson(outcome)) throw new SessionReconciliationRequired();
    return outcome;
  };
  return { handle: { ...owned.handle },
    activate: async () => {
      if (activated || closing) throw new SessionReconciliationRequired();
      activated = true;
      try {
        await Promise.race([options.authorize(structuredClone(launch)), owned.closed.then(() => { throw new SessionReconciliationRequired(); })]);
        if (retained) {
          // Start only the retained inert RPC worker; no adapter/configuration or
          // credential is sent until its exact closure handshake is verified.
          await owned.launch({ command: retained.runtime, args: ["--import", retained.guard, retained.worker, canonicalWorkflowHarnessJson(binding), directory], cwd: launch.declaration.selection.cwd,
            env: { ...options.inertEnvironment, BARRY_WORKFLOW_CLOSURE_SHA256: acceptedRuntime!.digest } });
          await readiness;
          await Promise.race([options.authorize(structuredClone(launch)), owned.closed.then(() => { throw new SessionReconciliationRequired(); })]);
          const selected = await rpc("select", { harnessId: options.harnessId, adapterModule: pathToFileURL(retained.adapter).href });
          if (canonicalWorkflowHarnessJson(selected) !== '{"approvalContinuation":"durable"}') throw new SessionReconciliationRequired();
          await Promise.race([options.authorize(structuredClone(launch)), owned.closed.then(() => { throw new SessionReconciliationRequired(); })]);
          if (Date.now() >= launch.declaration.selection.deadline || closing) throw new SessionReconciliationRequired();
        }
        const config = JSON.parse(canonicalWorkflowHarnessJson(await Promise.race([options.configure(structuredClone(launch)), owned.closed.then(() => { throw new SessionReconciliationRequired(); })]))) as SessionConfig;
        if (config.sessionId !== launch.sessionId || config.cwd !== launch.declaration.selection.cwd || config.model !== launch.declaration.selection.model
          || config.endpoint?.baseUrl !== launch.declaration.selection.endpoint) throw new Error("Workflow harness configuration changed");
        await Promise.race([options.authorize(structuredClone(launch)), owned.closed.then(() => { throw new SessionReconciliationRequired(); })]);
        if (Date.now() >= launch.declaration.selection.deadline || closing) throw new SessionReconciliationRequired();
        if (!retained && !options.runtime) {
          await owned.launch({ command: process.execPath, args: [...(options.nodeArgs ?? []), options.workerEntrypoint, canonicalWorkflowHarnessJson(binding), directory], cwd: config.cwd, env: { ...options.inertEnvironment } });
          await readiness;
        }
        await Promise.race([options.authorize(structuredClone(launch)), owned.closed.then(() => { throw new SessionReconciliationRequired(); })]);
        if (Date.now() >= launch.declaration.selection.deadline || closing) throw new SessionReconciliationRequired();
        const response = await rpc("activate", { harnessId: options.harnessId, adapterModule: retained ? pathToFileURL(retained.adapter).href : options.adapterModule, config });
        if (canonicalWorkflowHarnessJson(response) !== '{"approvalContinuation":"durable"}') throw new SessionReconciliationRequired();
      } catch (error) { await quiesce();throw error; }
      const harness: ContinuationHarness = {
        approvalContinuation: "durable",
        // The actual adapter validates in the child immediately before restore.
        validate: descriptor => { workflowHarnessContinuationSchema.parse(descriptor); },
        begin: (content, callback, conversation) => run("begin", { content, ...(conversation ? { conversation } : {}) }, callback),
        restore: (descriptor: ContinuationDescriptor, decisions, executor, callback) => run("restore", { descriptor, decisions: [...decisions] }, callback, executor),
        interrupt: async () => { void rpc("interrupt").catch(() => {});try { await owned.stop(); } catch { throw new SessionReconciliationRequired(); } },
        close: quiesce,
      };
      return harness;
    },
    proveCessation: async handle => canonicalWorkflowHarnessJson(handle) === canonicalWorkflowHarnessJson(owned.handle) && owned.proveCessation(),
    dispose: quiesce,
  };
}
