/** Actual Sessions destination admission and independent physical settlement fences. */
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonicalJson, executionHash, type SegmentOutcome, type TurnSnapshot } from "@barry-rocks/sdk/sessions";
import { approvedBoundsSchema, boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { encodeEffectJson } from "@barry-rocks/sdk/internal/tools";
import { TurnContinuations, ExecutionConflict } from "./turn-continuations.js";

export const workflowOwnerProcessSchema = z.strictObject({ pid: z.number().int().positive(), pid_started_at: z.number().finite().positive(), hostname: z.string().min(1).max(200), bootIdentity: z.string().min(1).max(200), startIdentity: z.literal("ps_utc_v1").optional() });
export type WorkflowOwnerProcess = z.infer<typeof workflowOwnerProcessSchema>;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const workflowRecoveryProofSchema = z.strictObject({
  version: z.literal(1), bindingKey: z.string().min(1).max(500), key: z.string().min(1).max(500),
  sessionId: z.string().min(1).max(500), turnId: z.string().min(1).max(500), segmentId: z.string().min(1).max(500), owner: z.string().min(1).max(500),
  outcomeHash: hashSchema, handleHash: hashSchema, ownerProcessHash: hashSchema, scopeHash: hashSchema, selectionHash: hashSchema,
  ownerDead: z.literal(true), groupAbsent: z.literal(true), hostname: z.string().min(1).max(200), bootIdentity: z.string().min(1).max(200), observedAt: z.number().finite().positive(),
});
export type WorkflowRecoveryProof = z.infer<typeof workflowRecoveryProofSchema>;
/** Separate proof of physical absence; no result or effect verdict is implied. */
export const workflowPhysicalProofSchema = workflowRecoveryProofSchema.omit({ outcomeHash: true }).extend({
  originalIntentHash: hashSchema, revision: z.number().int().positive(),
}).strict();
export type WorkflowPhysicalProof = z.infer<typeof workflowPhysicalProofSchema>;

const continuationSchema = z.strictObject({ format: z.string().min(1), version: z.number().int().positive(), adapterId: z.string().min(1), adapterVersion: z.string().min(1), harnessVersion: z.string().min(1), configFingerprint: z.string().min(1), payload: z.unknown() });
/** Match the private outcome wire bound without truncating durable checkpoints. */
export function workflowRecoveryOutcomeJson(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new ExecutionConflict("Workflow outcome exceeds nesting limit");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) throw new ExecutionConflict("Workflow outcome requires finite acyclic JSON");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) throw new ExecutionConflict("Workflow outcome requires plain JSON objects");
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.values(descriptors).some(property => property.get || property.set)) throw new ExecutionConflict("Workflow outcome cannot contain accessors");
    if (Array.isArray(item)) for (let index = 0; index < item.length; index++) visit(item[index], depth + 1);
    else for (const key of Object.keys(item)) visit(descriptors[key]!.value, depth + 1);
    ancestors.delete(item);
  };
  visit(value, 0);
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded) > 1048576) throw new ExecutionConflict("Workflow outcome exceeds private wire limit");
  return encoded;
}
export const workflowRecoveryOutcomeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("completed"), result: z.unknown().optional(), conversation: continuationSchema.optional() }),
  z.strictObject({ type: z.literal("failed"), error: z.string() }),
  z.strictObject({ type: z.literal("interrupted"), continuation: continuationSchema, calls: z.array(z.strictObject({ id: z.string().min(1).max(500), tool: z.string().min(1).max(500), input: z.unknown(), description: z.string().optional() })).min(1).max(1000) }),
]);

export const workflowDestinationSelectionSchema = z.strictObject({
  harness: z.string().min(1).max(200), model: z.string().min(1).max(500),
  endpoint: z.string().min(1).max(2000), cwd: z.string().min(1).max(4000),
  maxTurns: z.number().int().positive(), deadline: z.number().finite().positive(),
  runtime: z.strictObject({ version: z.literal(1), digest: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(), protocol: z.literal(1) }).optional(),
});
export type WorkflowDestinationSelection = z.infer<typeof workflowDestinationSelectionSchema>;
export interface WorkflowDestinationBinding {
  bindingKey: string; sessionId: string; identity: string; identityId: number; actorId: number;
  scope: ApprovedBounds; selection: WorkflowDestinationSelection;
}
export interface WorkflowDestinationTurn { key: string; sessionId: string; turnId: string; requestId: string; runId: string }
export interface WorkflowSettlement {
  segmentId: string; sessionId: string; turnId: string; owner: string;
  phase: "launching" | "preparing" | "not_started" | "handled" | "input" | "closing" | "ceased";
  ownerProcess: WorkflowOwnerProcess | null;
  handle: unknown | null; inputAt: string | null; closingAt: string | null; ceasedAt: string | null;
}
type BindingRow = { binding_key: string; session_id: string; identity: string; identity_id: number; actor_id: number; scope_json: string; selection_json: string };
type MappingRow = { key: string; session_id: string; turn_id: string; request_id: string; run_id: string };
type SettlementRow = { segment_id: string; session_id: string; turn_id: string; owner: string; phase: WorkflowSettlement["phase"]; owner_process_json: string | null; handle_json: string | null; input_at: string | null; closing_at: string | null; ceased_at: string | null };
const mapping = (row: MappingRow): WorkflowDestinationTurn => ({ key: row.key, sessionId: row.session_id, turnId: row.turn_id, requestId: row.request_id, runId: row.run_id });
const settlement = (row: SettlementRow): WorkflowSettlement => ({ segmentId: row.segment_id, sessionId: row.session_id, turnId: row.turn_id, owner: row.owner, phase: row.phase, ownerProcess: row.owner_process_json == null ? null : workflowOwnerProcessSchema.parse(JSON.parse(row.owner_process_json)), handle: row.handle_json === null ? null : JSON.parse(row.handle_json), inputAt: row.input_at, closingAt: row.closing_at, ceasedAt: row.ceased_at });
const keySchema = z.string().min(1).max(500);
export function validatedWorkflowDestinationScope(value: ApprovedBounds): ApprovedBounds {
  const scope = approvedBoundsSchema.parse(value), { fingerprint, ...evidence } = scope;
  if (!scope.identity || boundFingerprint(evidence) !== fingerprint) throw new ExecutionConflict("Invalid destination execution scope");
  return JSON.parse(encodeEffectJson(scope)) as ApprovedBounds;
}

/** Trusted worker calls ceased only after adapter-native physical cessation proof. */
export class WorkflowDestinations {
  private readonly ownerProcess: WorkflowOwnerProcess | undefined;
  constructor(private readonly db: Database.Database, ownerProcess?: WorkflowOwnerProcess) { this.ownerProcess = ownerProcess === undefined ? undefined : workflowOwnerProcessSchema.parse(ownerProcess); }
  private hasBagsColumn(): boolean {
    const columns = this.db.pragma("table_info(sessions)") as { name: string }[];
    return columns.some((c) => c.name === "bags");
  }
  turns(bindingKey: string): TurnContinuations { return new TurnContinuations(this.db, undefined, this.ownerProcess, { workflowBinding: bindingKey }); }
  bind(request: WorkflowDestinationBinding): WorkflowDestinationBinding & { boundFingerprint: string } {
    keySchema.parse(request.bindingKey); z.number().int().positive().parse(request.identityId); z.number().int().positive().parse(request.actorId);
    const scope = validatedWorkflowDestinationScope(request.scope), selection = workflowDestinationSelectionSchema.parse(request.selection);
    if (request.identity !== scope.identity || request.sessionId !== workflowSessionId(request.bindingKey, request.identity)
      || scope.harness && scope.harness !== selection.harness) throw new ExecutionConflict("Destination binding identity or selection mismatch");
    const scopeJson = encodeEffectJson(scope), selectionJson = encodeEffectJson(selection);
    this.db.transaction(() => {
      const intent = this.db.prepare("SELECT session_id,identity,scope_hash FROM session_workflow_bindings WHERE key=?").get(request.bindingKey) as { session_id: string; identity: string; scope_hash: string } | undefined;
      if (!intent || intent.session_id !== request.sessionId || intent.identity !== request.identity || intent.scope_hash !== scope.fingerprint) throw new ExecutionConflict("Destination requires matching session binding intent");
      const old = this.db.prepare("SELECT * FROM session_workflow_destinations WHERE binding_key=?").get(request.bindingKey) as BindingRow | undefined;
      if (old) {
        if (old.session_id !== request.sessionId || old.identity_id !== request.identityId || old.actor_id !== request.actorId || boundFingerprint(JSON.parse(old.scope_json)) !== boundFingerprint(scope) || boundFingerprint(JSON.parse(old.selection_json)) !== boundFingerprint(selection)) throw new ExecutionConflict("Destination declaration conflict");
        this.lookupSession(request.sessionId); return;
      }
      if (this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(request.sessionId)) throw new ExecutionConflict("Destination session already exists without its declaration");
      const metadataJson = encodeEffectJson({ source: "workflow-destination", working_directory: selection.cwd, provider: selection.harness, model: selection.model, workflow_bound: scope, workflow_identity_id: request.identityId });
      if (this.hasBagsColumn()) {
        this.db.prepare("INSERT INTO sessions(id,identity_id,user_id,active,state,status,bags,bound,metadata) VALUES(?,?,?,0,'open','pending',?,?,?)")
          .run(request.sessionId, request.identityId, request.actorId, encodeEffectJson(scope.bags ?? scope.traits ?? []), scope.bound === null ? null : encodeEffectJson(scope.bound), metadataJson);
      } else {
        this.db.prepare("INSERT INTO sessions(id,identity_id,user_id,active,state,status,traits,bounds,metadata) VALUES(?,?,?,0,'open','pending',?,?,?)")
          .run(request.sessionId, request.identityId, request.actorId, encodeEffectJson(scope.bags ?? scope.traits ?? []), encodeEffectJson(scope.bound === null ? [] : [scope.bound]), metadataJson);
      }
      this.db.prepare("INSERT INTO session_workflow_destinations(binding_key,session_id,identity,identity_id,actor_id,scope_json,selection_json) VALUES(?,?,?,?,?,?,?)")
        .run(request.bindingKey, request.sessionId, request.identity, request.identityId, request.actorId, scopeJson, selectionJson);
    }).immediate();
    const found = this.lookupSession(request.sessionId);
    if (!found) throw new ExecutionConflict("Destination declaration missing after binding");
    return found;
  }
  lookupSession(sessionId: string): (WorkflowDestinationBinding & { boundFingerprint: string }) | undefined {
    const row = this.db.prepare("SELECT * FROM session_workflow_destinations WHERE session_id=?").get(sessionId) as BindingRow | undefined;
    if (!row) return undefined;
    const scope = validatedWorkflowDestinationScope(JSON.parse(row.scope_json)), selection = workflowDestinationSelectionSchema.parse(JSON.parse(row.selection_json));
    const intent = this.db.prepare("SELECT session_id,identity,scope_hash FROM session_workflow_bindings WHERE key=?").get(row.binding_key) as { session_id: string; identity: string; scope_hash: string } | undefined;
    if (!intent || intent.session_id !== sessionId || intent.identity !== row.identity || intent.scope_hash !== scope.fingerprint) throw new ExecutionConflict("Destination binding intent changed");
    if (this.hasBagsColumn()) {
      const session = this.db.prepare("SELECT identity_id,user_id,bags,bound,bounds,metadata FROM sessions WHERE id=?").get(sessionId) as { identity_id: number; user_id: number; bags: string; bound: string | null; bounds: string; metadata: string } | undefined;
      if (!session || session.identity_id !== row.identity_id || session.user_id !== row.actor_id || scope.identity !== row.identity || workflowSessionId(row.binding_key, row.identity) !== sessionId
        || boundFingerprint(JSON.parse(session.bounds)) !== boundFingerprint([])
        || boundFingerprint(JSON.parse(session.bags)) !== boundFingerprint(scope.bags ?? scope.traits ?? []) || boundFingerprint(session.bound === null ? null : JSON.parse(session.bound)) !== boundFingerprint(scope.bound)) throw new ExecutionConflict("Destination session identity or execution ceiling mismatch");
      const metadata = JSON.parse(session.metadata) as Record<string, unknown>;
      if (boundFingerprint(metadata.workflow_bound) !== boundFingerprint(scope) || metadata.workflow_identity_id !== row.identity_id || metadata.source !== "workflow-destination" || metadata.working_directory !== selection.cwd || metadata.provider !== selection.harness || metadata.model !== selection.model) throw new ExecutionConflict("Destination session declaration changed");
    } else {
      const session = this.db.prepare("SELECT identity_id,user_id,traits,bound_id,bounds,metadata FROM sessions WHERE id=?").get(sessionId) as { identity_id: number; user_id: number; traits: string; bound_id: string | null; bounds: string; metadata: string } | undefined;
      if (!session || session.identity_id !== row.identity_id || session.user_id !== row.actor_id || scope.identity !== row.identity || workflowSessionId(row.binding_key, row.identity) !== sessionId
        || session.bound_id !== null || boundFingerprint(JSON.parse(session.traits)) !== boundFingerprint(scope.bags ?? scope.traits ?? []) || boundFingerprint(JSON.parse(session.bounds)) !== boundFingerprint(scope.bound === null ? [] : [scope.bound])) throw new ExecutionConflict("Destination session identity or execution ceiling mismatch");
      const metadata = JSON.parse(session.metadata) as Record<string, unknown>;
      if (boundFingerprint(metadata.workflow_bound) !== boundFingerprint(scope) || metadata.workflow_identity_id !== row.identity_id || metadata.source !== "workflow-destination" || metadata.working_directory !== selection.cwd || metadata.provider !== selection.harness || metadata.model !== selection.model) throw new ExecutionConflict("Destination session declaration changed");
    }
    return { bindingKey: row.binding_key, sessionId, identity: row.identity, identityId: row.identity_id, actorId: row.actor_id, scope, boundFingerprint: scope.fingerprint, selection };
  }
  admit(request: { key: string; sessionId: string; input: unknown; scope: ApprovedBounds }): { turn: ReturnType<TurnContinuations["snapshot"]>; created: boolean } {
    keySchema.parse(request.key); const scope = validatedWorkflowDestinationScope(request.scope), input = JSON.parse(encodeEffectJson(request.input)) as unknown;
    return this.db.transaction(() => {
      const declaration = this.lookupSession(request.sessionId);
      this.requireOpen(request.sessionId);
      if (!declaration || declaration.boundFingerprint !== scope.fingerprint) throw new ExecutionConflict("Destination has no matching approved scope");
      const binding = this.db.prepare("SELECT state FROM session_workflow_bindings WHERE key=?").get(declaration.bindingKey) as { state: string };
      const intent = this.db.prepare("SELECT session_id,request_hash,state FROM session_workflow_turns WHERE key=?").get(request.key) as { session_id: string; request_hash: string; state: string } | undefined;
      if (binding.state !== "ready" || !intent || intent.session_id !== request.sessionId || intent.request_hash !== boundFingerprint({ sessionId: request.sessionId, input, scope }) || !["admitted", "active"].includes(intent.state)) throw new ExecutionConflict("Destination requires matching active turn intent");
      if (this.cancelled(request.key)) throw new ExecutionConflict("Destination turn was cancelled before launch");
      const old = this.inspect(request.key);
      if (old) return { turn: this.turns(declaration.bindingKey).snapshot(old.sessionId, old.turnId), created: false };
      const stable = boundFingerprint({ key: request.key, sessionId: request.sessionId });
      const requestId = `workflow-request-${stable}`, runId = `workflow-segment-${stable}`;
      const turn = this.turns(declaration.bindingKey).admit({ sessionId: request.sessionId, requestId, runId, actor: `workflow:${declaration.identity}`, content: input, policy: { mode: "automatic" } });
      this.db.prepare("INSERT INTO session_workflow_destination_turns(key,session_id,turn_id,request_id,run_id) VALUES(?,?,?,?,?)").run(request.key, request.sessionId, turn.id, requestId, runId);
      return { turn, created: true };
    }).immediate();
  }
  inspect(key: string): WorkflowDestinationTurn | undefined {
    const row = this.db.prepare("SELECT * FROM session_workflow_destination_turns WHERE key=?").get(key) as MappingRow | undefined;
    return row && mapping(row);
  }
  cancelled(key: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM session_workflow_destination_cancellations WHERE key=?").get(key)); }
  cancel(key: string): ReturnType<TurnContinuations["snapshot"]> | undefined {
    keySchema.parse(key);
    return this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO session_workflow_destination_cancellations(key,cancelled_at) VALUES(?,?)").run(key, new Date().toISOString());
      const found = this.inspect(key);
      if (!found) return undefined;
      const declared = this.lookupSession(found.sessionId);
      if (!declared) throw new ExecutionConflict("Destination declaration missing");
      return this.turns(declared.bindingKey).cancel(found.sessionId, found.turnId);
    }).immediate();
  }
  private requireOpen(sessionId: string): void {
    if (!this.db.prepare("SELECT 1 FROM sessions WHERE id=? AND state='open' AND ended_at IS NULL").get(sessionId)) throw new ExecutionConflict("Destination session is closed");
  }
  claim(sessionId: string, turnId: string, segmentId: string, owner: string): boolean {
    keySchema.parse(owner); keySchema.parse(segmentId);
    return this.db.transaction(() => {
      const found = this.db.prepare("SELECT key FROM session_workflow_destination_turns WHERE session_id=? AND turn_id=?").get(sessionId, turnId) as { key: string } | undefined;
      if (!found || this.cancelled(found.key) || this.db.prepare("SELECT 1 FROM session_workflow_settlements WHERE segment_id=? OR (session_id=? AND ceased_at IS NULL)").get(segmentId, sessionId)) return false;
      const declared = this.lookupSession(sessionId); if (!declared) return false;
      this.requireOpen(sessionId);
      const turns = this.turns(declared.bindingKey);
      if (turns.snapshot(sessionId, turnId).runId !== segmentId || !turns.claim(sessionId, turnId, owner)) return false;
      this.db.prepare("INSERT INTO session_workflow_settlements(segment_id,session_id,turn_id,owner,phase,created_at,owner_process_json) VALUES(?,?,?,?,'launching',?,?)").run(segmentId, sessionId, turnId, owner, new Date().toISOString(), this.ownerProcess ? encodeEffectJson(this.ownerProcess) : null); return true;
    }).immediate();
  }
  private owned(segmentId: string, owner: string): SettlementRow {
    const row = this.db.prepare("SELECT * FROM session_workflow_settlements WHERE segment_id=?").get(segmentId) as SettlementRow | undefined;
    if (!row || row.owner !== owner) throw new ExecutionConflict("Physical settlement ownership mismatch");
    return row;
  }
  /** Commit before invoking any adapter preparation that could acquire resources. */
  preparing(segmentId: string, owner: string): void {
    this.db.transaction(() => {
      const row = this.owned(segmentId, owner);
      const found = this.db.prepare("SELECT key FROM session_workflow_destination_turns WHERE turn_id=?").get(row.turn_id) as { key: string };
      this.requireOpen(row.session_id);
      if (row.phase !== "launching" || this.cancelled(found.key)) throw new ExecutionConflict("Physical preparation is fenced");
      this.db.prepare("UPDATE session_workflow_settlements SET phase='preparing' WHERE segment_id=?").run(segmentId);
    }).immediate();
  }
  /** Trusted driver supplies affirmative pre-native refusal, never handle absence. */
  refusePreparation(input: { bindingKey: string; sessionId: string; turnId: string; segmentId: string; owner: string; declarationHash: string }): void {
    this.db.transaction(() => {
      const fence = this.owned(input.segmentId, input.owner), declaration = this.lookupSession(input.sessionId);
      if (!declaration || fence.session_id !== input.sessionId || fence.turn_id !== input.turnId || declaration.bindingKey !== input.bindingKey
        || boundFingerprint({ ...declaration, boundFingerprint: undefined }) !== input.declarationHash || !this.ownerProcess || !fence.owner_process_json)
        throw new ExecutionConflict("Preparation refusal binding conflict");
      const retainedOwner = workflowOwnerProcessSchema.parse(JSON.parse(fence.owner_process_json));
      const ownerHash = boundFingerprint(retainedOwner);
      if (!retainedOwner.startIdentity || ownerHash !== boundFingerprint(this.ownerProcess)) throw new ExecutionConflict("Preparation refusal owner conflict");
      const mapped = this.db.prepare("SELECT key,request_id FROM session_workflow_destination_turns WHERE session_id=? AND turn_id=?").get(input.sessionId, input.turnId) as { key: string; request_id: string } | undefined;
      const intent = mapped && this.db.prepare("SELECT session_id,request_hash FROM session_workflow_turns WHERE key=?").get(mapped.key) as { session_id: string; request_hash: string } | undefined;
      const original = this.db.prepare("SELECT session_id,input_json,request_id FROM session_turns WHERE id=?").get(input.turnId) as { session_id: string; input_json: string; request_id: string } | undefined;
      const segment = this.db.prepare("SELECT turn_id FROM session_run_segments WHERE id=?").get(input.segmentId) as { turn_id: string } | undefined;
      if (!mapped || !intent || !original || !segment || segment.turn_id !== input.turnId || intent.session_id !== input.sessionId || original.session_id !== input.sessionId
        || original.request_id !== mapped.request_id || intent.request_hash !== boundFingerprint({ sessionId: input.sessionId, input: JSON.parse(original.input_json), scope: declaration.scope }))
        throw new ExecutionConflict("Preparation refusal intent conflict");
      const expected = { segment_id: input.segmentId, session_id: input.sessionId, turn_id: input.turnId, owner: input.owner, binding_key: input.bindingKey,
        declaration_hash: input.declarationHash, intent_hash: intent.request_hash, owner_process_hash: ownerHash, proof_kind: "native-preparation-not-invoked@1" };
      const old = this.db.prepare("SELECT * FROM session_workflow_preparation_refusals WHERE segment_id=?").get(input.segmentId) as (typeof expected & { refused_at: string }) | undefined;
      if (old) {
        const { refused_at, ...binding } = old;
        if (boundFingerprint(binding) !== boundFingerprint(expected) || fence.phase !== "not_started" || fence.ceased_at !== refused_at || fence.handle_json !== null || fence.input_at !== null)
          throw new ExecutionConflict("Preparation refusal receipt conflict");
        return;
      }
      if (fence.phase !== "preparing" || fence.handle_json !== null || fence.input_at !== null || fence.ceased_at !== null)
        throw new ExecutionConflict("Native preparation may have been invoked");
      const refusedAt = new Date().toISOString();
      this.db.prepare(`INSERT INTO session_workflow_preparation_refusals(segment_id,session_id,turn_id,owner,binding_key,declaration_hash,intent_hash,owner_process_hash,proof_kind,refused_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(...Object.values(expected), refusedAt);
      this.db.prepare("UPDATE session_workflow_settlements SET phase='not_started',ceased_at=? WHERE segment_id=?").run(refusedAt, input.segmentId);
    }).immediate();
  }
  /** Trusted owner proves adapter preparation was never invoked, including while waiting for a slot. */
  notStarted(segmentId: string, owner: string): void {
    this.db.transaction(() => {
      const row = this.owned(segmentId, owner);
      if (row.phase !== "launching" || row.handle_json !== null || row.input_at !== null) throw new ExecutionConflict("Physical preparation may have started; retain launch uncertainty");
      this.db.prepare("UPDATE session_workflow_settlements SET phase='not_started',ceased_at=? WHERE segment_id=?").run(new Date().toISOString(), segmentId);
    }).immediate();
  }
  handle(segmentId: string, owner: string, value: unknown): void {
    const json = encodeEffectJson(value); if (value === null) throw new ExecutionConflict("Physical handle must be known");
    this.db.transaction(() => {
      const row = this.owned(segmentId, owner);
      if (row.handle_json !== null) { if (boundFingerprint(JSON.parse(row.handle_json)) !== boundFingerprint(value)) throw new ExecutionConflict("Physical handle conflict"); return; }
      if (row.phase !== "launching" && row.phase !== "preparing") throw new ExecutionConflict("Physical handle is not expected");
      this.db.prepare("UPDATE session_workflow_settlements SET handle_json=?,phase='handled' WHERE segment_id=?").run(json, segmentId);
    }).immediate();
  }
  input(segmentId: string, owner: string): void {
    this.db.transaction(() => {
      const row = this.owned(segmentId, owner);
      this.requireOpen(row.session_id);
      const found = this.db.prepare("SELECT key FROM session_workflow_destination_turns WHERE turn_id=?").get(row.turn_id) as { key: string };
      if (row.phase !== "handled" || this.cancelled(found.key)) throw new ExecutionConflict("Physical input is fenced");
      this.db.prepare("UPDATE session_workflow_settlements SET phase='input',input_at=? WHERE segment_id=?").run(new Date().toISOString(), segmentId);
    }).immediate();
  }
  closing(segmentId: string, owner: string): void {
    this.db.transaction(() => {
      const row = this.owned(segmentId, owner);
      if (row.phase === "closing" || row.phase === "ceased") return;
      if (!row.handle_json) throw new ExecutionConflict("Physical handle is unknown; retain launch uncertainty");
      this.db.prepare("UPDATE session_workflow_settlements SET phase='closing',closing_at=? WHERE segment_id=?").run(new Date().toISOString(), segmentId);
    }).immediate();
  }
  ceased(segmentId: string, owner: string): void {
    this.db.transaction(() => {
      const row = this.owned(segmentId, owner); if (row.phase === "ceased") return;
      if (!row.handle_json || row.phase !== "closing") throw new ExecutionConflict("Physical cessation requires the known closing handle");
      this.db.prepare("UPDATE session_workflow_settlements SET phase='ceased',ceased_at=? WHERE segment_id=?").run(new Date().toISOString(), segmentId);
    }).immediate();
  }
  /** Trusted native observer only: proof assertions are never caller authority.
   * This writer transaction imports metadata without launching or resuming work. */
  recoverOutcome(input: { bindingKey: string; key: string; sessionId: string; turnId: string; segmentId: string; owner: string; expectedRevision: number; outcome: SegmentOutcome; outcomeHash: string; proof: unknown }): TurnSnapshot {
    z.number().int().positive().parse(input.expectedRevision);
    // Preserve the full private checkpoint/result bound. Outer completed-result
    // publication retains its independent, narrower durable receipt contract.
    workflowRecoveryOutcomeJson(input.outcome);
    const outcome = workflowRecoveryOutcomeSchema.parse(input.outcome), outcomeJson = workflowRecoveryOutcomeJson(outcome), outcomeHash = executionHash(outcome);
    if (hashSchema.parse(input.outcomeHash) !== outcomeHash) throw new ExecutionConflict("Workflow recovery outcome hash mismatch");
    const proof = workflowRecoveryProofSchema.parse(input.proof), proofJson = canonicalJson(proof);
    for (const name of ["bindingKey", "key", "sessionId", "turnId", "segmentId", "owner"] as const) if (input[name] !== proof[name]) throw new ExecutionConflict("Workflow recovery proof binding mismatch");
    if (proof.outcomeHash !== outcomeHash) throw new ExecutionConflict("Workflow recovery proof outcome mismatch");
    return this.db.transaction(() => {
      const declaration = this.lookupSession(input.sessionId), found = this.inspect(input.key);
      if (!declaration || declaration.bindingKey !== input.bindingKey || !found || found.sessionId !== input.sessionId || found.turnId !== input.turnId) throw new ExecutionConflict("Workflow recovery destination mismatch");
      const intent = this.db.prepare("SELECT session_id,state,request_hash FROM session_workflow_turns WHERE key=?").get(input.key) as { session_id: string; state: string; request_hash: string } | undefined;
      const original = this.db.prepare("SELECT input_json,request_id FROM session_turns WHERE id=? AND session_id=?").get(input.turnId, input.sessionId) as { input_json: string; request_id: string } | undefined;
      const binding = this.db.prepare("SELECT state FROM session_workflow_bindings WHERE key=?").get(input.bindingKey) as { state: string } | undefined;
      if (!original || original.request_id !== found.requestId || binding?.state !== "ready" || intent?.request_hash !== boundFingerprint({ sessionId: input.sessionId, input: JSON.parse(original.input_json), scope: declaration.scope })) throw new ExecutionConflict("Workflow recovery original intent changed");
      if (!intent || intent.session_id !== input.sessionId || this.cancelled(input.key) || ["interrupting", "interrupted"].includes(intent.state)) throw new ExecutionConflict("Workflow recovery cancelled or conflicting intent");
      const fence = this.owned(input.segmentId, input.owner);
      if (fence.session_id !== input.sessionId || fence.turn_id !== input.turnId || !fence.owner_process_json || !fence.handle_json || !fence.input_at || !["input", "closing", "ceased"].includes(fence.phase)) throw new ExecutionConflict("Workflow recovery lacks known physical input ownership");
      const ownerProcess = workflowOwnerProcessSchema.parse(JSON.parse(fence.owner_process_json));
      const handle = JSON.parse(fence.handle_json) as { kind?: unknown; pid?: unknown; pgid?: unknown; pidStartedAt?: unknown; hostname?: unknown; bootIdentity?: unknown; sessionId?: unknown; turnId?: unknown; segmentId?: unknown };
      if (handle.kind !== "process" || typeof handle.pid !== "number" || handle.pid !== handle.pgid || handle.pid <= 0 || !Number.isSafeInteger(handle.pid)
        || typeof handle.pidStartedAt !== "number" || !Number.isFinite(handle.pidStartedAt) || handle.pidStartedAt <= 0
        || handle.sessionId !== input.sessionId || handle.turnId !== input.turnId || handle.segmentId !== input.segmentId
        || handle.hostname !== ownerProcess.hostname || handle.bootIdentity !== ownerProcess.bootIdentity || proof.hostname !== ownerProcess.hostname || proof.bootIdentity !== ownerProcess.bootIdentity
        || proof.handleHash !== boundFingerprint(handle) || proof.ownerProcessHash !== boundFingerprint(ownerProcess) || proof.scopeHash !== boundFingerprint(declaration.scope) || proof.selectionHash !== boundFingerprint(declaration.selection)) throw new ExecutionConflict("Workflow recovery physical proof conflict");
      const turns = this.turns(input.bindingKey), before = turns.snapshot(input.sessionId, input.turnId);
      if (before.runId !== input.segmentId) throw new ExecutionConflict("Workflow recovery segment is stale");
      if (this.db.prepare("SELECT 1 FROM session_call_outcomes WHERE turn_id=? AND state IN ('executing','uncertain')").get(input.turnId)) throw new ExecutionConflict("Workflow recovery effect outcome remains uncertain");
      const receipt = this.db.prepare("SELECT * FROM session_workflow_outcome_recoveries WHERE segment_id=?").get(input.segmentId) as { outcome_hash: string; outcome_json: string; physicalproof_json: string } | undefined;
      if (receipt) {
        const retained = workflowRecoveryProofSchema.parse(JSON.parse(receipt.physicalproof_json));
        const { observedAt: _retainedTime, ...retainedBinding } = retained, { observedAt: _newTime, ...newBinding } = proof;
        if (receipt.outcome_hash !== outcomeHash || receipt.outcome_json !== outcomeJson || executionHash(retainedBinding) !== executionHash(newBinding)) throw new ExecutionConflict("Workflow recovery receipt conflict");
        return before;
      }
      if (before.revision !== input.expectedRevision) throw new ExecutionConflict("Workflow recovery revision changed");
      if (this.db.prepare("SELECT 1 FROM session_workflow_settlements WHERE session_id=? AND segment_id<>? AND ceased_at IS NULL").get(input.sessionId, input.segmentId)) throw new ExecutionConflict("Another physical segment remains unsettled");
      const repaired = turns.recoverWorkflowOutcome({ sessionId: input.sessionId, turnId: input.turnId, segmentId: input.segmentId, owner: input.owner, expectedRevision: input.expectedRevision, outcome });
      this.closing(input.segmentId, input.owner);this.ceased(input.segmentId, input.owner);
      this.db.prepare("INSERT INTO session_workflow_outcome_recoveries(segment_id,outcome_hash,outcome_json,physicalproof_json,prior_revision,repaired_revision,repaired_at) VALUES(?,?,?,?,?,?,?)")
        .run(input.segmentId, outcomeHash, outcomeJson, proofJson, before.revision, repaired.revision, new Date().toISOString());
      return repaired;
    }).immediate();
  }
  /** Trusted native observation only. This CAS changes the physical fence and
   * append-only receipt, never logical outcome, cancellation, owner or effects. */
  settlePhysical(input: { bindingKey: string; key: string; sessionId: string; turnId: string; segmentId: string; owner: string; expectedRevision: number; proof: unknown }): WorkflowSettlement {
    z.number().int().positive().parse(input.expectedRevision);
    const proof = workflowPhysicalProofSchema.parse(input.proof);
    for (const name of ["bindingKey", "key", "sessionId", "turnId", "segmentId", "owner"] as const) if (input[name] !== proof[name]) throw new ExecutionConflict("Physical settlement proof binding mismatch");
    if (proof.revision !== input.expectedRevision) throw new ExecutionConflict("Physical settlement proof revision mismatch");
    return this.db.transaction(() => {
      const declaration = this.lookupSession(input.sessionId), found = this.inspect(input.key);
      if (!declaration || declaration.bindingKey !== input.bindingKey || !found || found.sessionId !== input.sessionId || found.turnId !== input.turnId) throw new ExecutionConflict("Physical settlement destination mismatch");
      const intent = this.db.prepare("SELECT session_id,request_hash FROM session_workflow_turns WHERE key=?").get(input.key) as { session_id: string; request_hash: string } | undefined;
      const original = this.db.prepare("SELECT input_json,request_id,revision FROM session_turns WHERE id=? AND session_id=?").get(input.turnId, input.sessionId) as { input_json: string; request_id: string; revision: number } | undefined;
      const binding = this.db.prepare("SELECT state FROM session_workflow_bindings WHERE key=?").get(input.bindingKey) as { state: string } | undefined;
      if (!original || original.request_id !== found.requestId || binding?.state !== "ready" || !intent || intent.session_id !== input.sessionId
        || intent.request_hash !== proof.originalIntentHash || intent.request_hash !== boundFingerprint({ sessionId: input.sessionId, input: JSON.parse(original.input_json), scope: declaration.scope })) throw new ExecutionConflict("Physical settlement original intent changed");
      // A committed approval can already name a successor run while this older
      // physical fence still needs repair. Bind the segment to its actual turn,
      // CAS the current revision, and leave the successor's metadata untouched.
      const segment = this.db.prepare("SELECT turn_id FROM session_run_segments WHERE id=?").get(input.segmentId) as { turn_id: string } | undefined;
      if (!segment || segment.turn_id !== input.turnId) throw new ExecutionConflict("Physical settlement segment changed");
      const fence = this.owned(input.segmentId, input.owner);
      if (fence.session_id !== input.sessionId || fence.turn_id !== input.turnId || !fence.owner_process_json || !fence.handle_json || !["handled", "input", "closing", "ceased"].includes(fence.phase)) throw new ExecutionConflict("Physical settlement lacks known ownership and handle");
      const ownerProcess = workflowOwnerProcessSchema.parse(JSON.parse(fence.owner_process_json));
      const handle = JSON.parse(fence.handle_json) as { kind?: unknown; pid?: unknown; pgid?: unknown; pidStartedAt?: unknown; hostname?: unknown; bootIdentity?: unknown; sessionId?: unknown; turnId?: unknown; segmentId?: unknown };
      if (handle.kind !== "process" || typeof handle.pid !== "number" || !Number.isSafeInteger(handle.pid) || handle.pid <= 0 || handle.pid !== handle.pgid || handle.pid === ownerProcess.pid
        || typeof handle.pidStartedAt !== "number" || !Number.isFinite(handle.pidStartedAt) || handle.pidStartedAt <= 0
        || handle.sessionId !== input.sessionId || handle.turnId !== input.turnId || handle.segmentId !== input.segmentId
        || handle.hostname !== ownerProcess.hostname || handle.bootIdentity !== ownerProcess.bootIdentity || proof.hostname !== ownerProcess.hostname || proof.bootIdentity !== ownerProcess.bootIdentity
        || proof.handleHash !== boundFingerprint(handle) || proof.ownerProcessHash !== boundFingerprint(ownerProcess) || proof.scopeHash !== boundFingerprint(declaration.scope) || proof.selectionHash !== boundFingerprint(declaration.selection)) throw new ExecutionConflict("Physical settlement native proof conflict");
      const receipt = this.db.prepare("SELECT proof_json,revision FROM session_workflow_physical_settlements WHERE segment_id=?").get(input.segmentId) as { proof_json: string; revision: number } | undefined;
      if (receipt) {
        const retained = workflowPhysicalProofSchema.parse(JSON.parse(receipt.proof_json));
        const { observedAt: _oldTime, ...oldBinding } = retained, { observedAt: _newTime, ...newBinding } = proof;
        if (receipt.revision !== input.expectedRevision || executionHash(oldBinding) !== executionHash(newBinding) || fence.phase !== "ceased") throw new ExecutionConflict("Physical settlement receipt conflict");
        return settlement(fence);
      }
      // A recorded proof can be replayed after separate logical metadata repair.
      // Only a first physical mutation requires the current logical revision.
      if (original.revision !== input.expectedRevision) throw new ExecutionConflict("Physical settlement revision changed");
      // No successful/malformed/missing outcome is read. Unknown tool effects,
      // cancellation winners and logical ownership remain exactly as recorded.
      this.closing(input.segmentId, input.owner);this.ceased(input.segmentId, input.owner);
      this.db.prepare("INSERT INTO session_workflow_physical_settlements(segment_id,proof_json,revision,settled_at) VALUES(?,?,?,?)")
        .run(input.segmentId, canonicalJson(proof), input.expectedRevision, new Date().toISOString());
      return settlement(this.owned(input.segmentId, input.owner));
    }).immediate();
  }
  settlements(turnId: string): WorkflowSettlement[] { return (this.db.prepare("SELECT * FROM session_workflow_settlements WHERE turn_id=? ORDER BY rowid").all(turnId) as SettlementRow[]).map(settlement); }
  unsettled(): WorkflowSettlement[] { return (this.db.prepare("SELECT * FROM session_workflow_settlements WHERE ceased_at IS NULL ORDER BY rowid").all() as SettlementRow[]).map(settlement); }
}
