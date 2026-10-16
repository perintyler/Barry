import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Liveness, ProcessIdentity } from "../process-liveness.js";
import {
  canonicalJson, executionHash,
  type ApprovalDecision, type ContinuationDescriptor, type PermissionRequest,
  type RecordedCallResult, type ReviewRules, type TurnSnapshot, type SegmentOutcome,
} from "@barry-rocks/sdk/sessions";

interface TurnRow {
  id: string; session_id: string; run_id: string; state: TurnSnapshot["state"];
  revision: number; policy_json: string; owner: string | null;
  continuation_json: string | null; continuation_hash: string | null;
  result_json: string | null; error: string | null;
}
interface InterruptRow {
  id: string; run_id: string; call_id: string; call_json: string;
  status: TurnSnapshot["interrupts"][number]["status"];
  expires_at: string | null; decision_json: string | null;
}

const eventListeners = new Map<string, Set<() => void>>();
export function watchTurnEvents(sessionId:string, listener:()=>void):()=>void {
  const set=eventListeners.get(sessionId)??new Set();set.add(listener);eventListeners.set(sessionId,set);
  return ()=>{set.delete(listener);if (!set.size) eventListeners.delete(sessionId);};
}
export class ExecutionConflict extends Error {}
export class ExecutionRecoveryRequired extends Error {}

/** The caller supplies an already-open, migrated, identity-scoped store. */
export class TurnContinuations {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly ownerProcess?: ProcessIdentity,
    private readonly access: { workflowBinding?: string } = {},
  ) {}

  /** Workflow destinations have a separate executor; ordinary turn recovery cannot adopt them. */
  private canDrive(sessionId: string): boolean {
    // Older explicitly constructed fixture stores may predate destination ownership.
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_workflow_destinations'").get();
    const row = exists ? this.db.prepare("SELECT binding_key FROM session_workflow_destinations WHERE session_id=?").get(sessionId) as { binding_key: string } | undefined : undefined;
    return row ? row.binding_key === this.access.workflowBinding : this.access.workflowBinding === undefined;
  }

  private assertDriver(sessionId: string): void {
    if (!this.canDrive(sessionId)) throw new ExecutionConflict("This session belongs to its workflow executor");
  }

  /** A dead owner permits recording loss, never replaying an in-flight effect. */
  reconcileOwners(classify: (identity: ProcessIdentity) => Liveness, limit = 32): void {
    const workflowTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_workflow_destinations'").get();
    const ownership = !workflowTable ? "" : this.access.workflowBinding === undefined
      ? "AND NOT EXISTS(SELECT 1 FROM session_workflow_destinations d WHERE d.session_id=session_turns.session_id)"
      : "AND EXISTS(SELECT 1 FROM session_workflow_destinations d WHERE d.session_id=session_turns.session_id AND d.binding_key=?)";
    const rows = this.db.prepare(`SELECT id,session_id,owner,owner_process_json,continuation_json,state
      FROM session_turns WHERE owner_process_json IS NOT NULL
      AND (owner IS NOT NULL OR state='waiting_for_input') ${ownership} ORDER BY owner_checked_at IS NOT NULL,owner_checked_at,rowid LIMIT ?`)
      .all(...(workflowTable && this.access.workflowBinding !== undefined ? [this.access.workflowBinding, limit] : [limit])) as Array<{ id: string; session_id: string; owner: string | null; owner_process_json: string; continuation_json: string | null; state: string }>;
    for (const row of rows) {
      if (!this.canDrive(row.session_id)) continue;
      this.db.prepare("UPDATE session_turns SET owner_checked_at=? WHERE id=?").run(this.now(), row.id);
      if (row.state === "waiting_for_input" && (!row.continuation_json || (JSON.parse(row.continuation_json) as ContinuationDescriptor).format !== "barry.live.permission")) continue;
      const verdict = classify(JSON.parse(row.owner_process_json) as ProcessIdentity);
      if (verdict.state !== "dead") continue;
      this.transaction(() => {
        const current = this.row(row.session_id, row.id);
        if (current.owner !== row.owner || current.state !== row.state) return;
        if (current.state === "running" && current.owner) {
          this.db.prepare("UPDATE session_call_outcomes SET state='uncertain' WHERE turn_id=? AND state='executing'").run(row.id);
          this.finish(row.session_id, row.id, current.owner, { state: "recovery_required", error: `Execution owner died (${verdict.reason}); reconcile harness children and effects before recovery` });
        } else if (current.state === "waiting_for_input") {
          this.lost(row.session_id, row.id, "The original live approval callback was lost with its process");
        }
        // Child processes can survive their service. Keep cancelled ownership
        // until explicit physical cleanup confirms that they have stopped.
        this.db.prepare("UPDATE session_turns SET owner_process_json=NULL WHERE id=?").run(row.id);
      });
    }
  }

  private transaction<T>(operation: () => T): T { return this.db.transaction(operation).immediate(); }

  private row(sessionId: string, turnId: string): TurnRow {
    const row = this.db.prepare("SELECT * FROM session_turns WHERE session_id=? AND id=?").get(sessionId, turnId) as TurnRow | undefined;
    if (!row) throw new ExecutionConflict("Turn does not belong to this session");
    return row;
  }

  snapshot(sessionId: string, turnId: string): TurnSnapshot {
    const row = this.row(sessionId, turnId);
    const interrupts = this.db.prepare("SELECT * FROM session_interrupts WHERE turn_id=? ORDER BY rowid").all(turnId) as InterruptRow[];
    return {
      id: row.id, sessionId: row.session_id, runId: row.run_id, state: row.state,
      revision: row.revision, reviewPolicy: JSON.parse(row.policy_json),
      interrupts: interrupts.map((interrupt) => ({
        id: interrupt.id, runId: interrupt.run_id, call: JSON.parse(interrupt.call_json), status: interrupt.status,
        ...(interrupt.expires_at ? { expiresAt: interrupt.expires_at } : {}),
      })),
      ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  active(sessionId: string): TurnSnapshot | undefined {
    const row = this.db.prepare("SELECT id FROM session_turns WHERE session_id=? AND (state IN ('running','waiting_for_input','recovery_required') OR owner IS NOT NULL) ORDER BY rowid DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
    return row ? this.snapshot(sessionId, row.id) : undefined;
  }

  byRun(sessionId: string, runId: string): { turn: TurnSnapshot; input: unknown; initial: boolean } | undefined {
    const row = this.db.prepare("SELECT t.id,t.input_json,EXISTS(SELECT 1 FROM session_resolution_receipts r WHERE r.turn_id=t.id AND r.run_id=s.id) AS resumed FROM session_turns t JOIN session_run_segments s ON s.turn_id=t.id WHERE t.session_id=? AND s.id=?").get(sessionId, runId) as { id: string; input_json: string; resumed: number } | undefined;
    return row ? { turn: this.snapshot(sessionId, row.id), input: JSON.parse(row.input_json), initial: !row.resumed } : undefined;
  }

  runnable(): Array<{ turn: TurnSnapshot; input: unknown; restoring: boolean }> {
    const sessionsWithQueued = this.db.prepare("SELECT DISTINCT session_id FROM session_turns WHERE state='queued'").all() as Array<{ session_id: string }>;
    for (const { session_id } of sessionsWithQueued) {
      if (!this.canDrive(session_id)) continue;
      this.promoteQueued(session_id);
    }
    const rows = this.db.prepare("SELECT id,session_id,input_json,continuation_json FROM session_turns WHERE state='running' AND owner IS NULL").all() as Array<{ id: string; session_id: string; input_json: string; continuation_json: string | null }>;
    return rows.filter(row => this.canDrive(row.session_id)).map((row) => ({ turn: this.snapshot(row.session_id, row.id), input: JSON.parse(row.input_json), restoring: row.continuation_json !== null }));
  }

  promoteQueued(sessionId: string): { turn: TurnSnapshot; input: unknown } | undefined {
    if (!this.canDrive(sessionId)) return undefined;
    return this.transaction(() => {
      if (!this.canDrive(sessionId)) return undefined;
      if (this.active(sessionId)) return undefined;
      const next = this.db.prepare("SELECT id,run_id,input_json FROM session_turns WHERE session_id=? AND state='queued' ORDER BY rowid ASC LIMIT 1").get(sessionId) as { id: string; run_id: string; input_json: string } | undefined;
      if (!next) return undefined;
      const at = this.now();
      this.db.prepare("UPDATE session_turns SET state='running',updated_at=? WHERE id=?").run(at, next.id);
      this.db.prepare("INSERT INTO session_run_segments(id,turn_id,state,created_at) VALUES(?,?,'accepted',?)").run(next.run_id, next.id, at);
      this.append(sessionId, next.id, { type: "segment_started" });
      return { turn: this.snapshot(sessionId, next.id), input: JSON.parse(next.input_json) };
    });
  }

  inputs(sessionId: string): Array<{ turnId: string; runId: string; input: unknown }> {
    const rows = this.db.prepare("SELECT id,run_id,input_json FROM session_turns WHERE session_id=? ORDER BY rowid").all(sessionId) as Array<{ id: string; run_id: string; input_json: string }>;
    return rows.map((row) => ({ turnId: row.id, runId: row.run_id, input: JSON.parse(row.input_json) }));
  }

  cursor(sessionId: string): number {
    return (this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM session_execution_events WHERE session_id=?").get(sessionId) as { sequence: number }).sequence;
  }

  pendingHistory(limit = 128): Array<{ sequence: number; sessionId: string; turnId: string; runId: string; event: unknown; input: unknown; initial: boolean; createdAt: string }> {
    const rows = this.db.prepare(`SELECT e.*,t.input_json,
      e.run_id=(SELECT id FROM session_run_segments WHERE turn_id=e.turn_id ORDER BY rowid LIMIT 1) AS initial
      FROM session_execution_events e JOIN session_turns t ON t.id=e.turn_id
      WHERE e.history_projected_at IS NULL ORDER BY e.sequence LIMIT ?`).all(limit) as Array<{
        sequence: number; session_id: string; turn_id: string; run_id: string; event_json: string; input_json: string; initial: number; created_at: string;
      }>;
    return rows.map((row) => ({ sequence: row.sequence, sessionId: row.session_id, turnId: row.turn_id, runId: row.run_id,
      event: JSON.parse(row.event_json), input: JSON.parse(row.input_json), initial: !!row.initial, createdAt: row.created_at }));
  }

  acknowledgeHistory(sequence: number): void {
    this.db.prepare("UPDATE session_execution_events SET history_projected_at=? WHERE sequence=? AND history_projected_at IS NULL").run(this.now(), sequence);
  }

  segmentText(sessionId: string, runId: string, through: number): string {
    const rows = this.db.prepare("SELECT event_json FROM session_execution_events WHERE session_id=? AND run_id=? AND sequence<=? AND json_extract(event_json,'$.type')='partial' ORDER BY sequence").all(sessionId, runId, through) as Array<{ event_json: string }>;
    return rows.map((row) => (JSON.parse(row.event_json) as { text: string }).text).join("");
  }

  publicState(sessionId: string): { turn: TurnSnapshot | null; cursor: number; inputs: ReturnType<TurnContinuations["inputs"]>; events: ReturnType<TurnContinuations["replay"]> } {
    return this.transaction(() => {
      const latest = this.db.prepare("SELECT id FROM session_turns WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
      const events: ReturnType<TurnContinuations["replay"]> = [];
      let after = 0;
      while (true) {
        const page = this.replay(sessionId, after, 1024);
        events.push(...page);
        if (page.length < 1024) break;
        after = page.at(-1)!.sequence;
      }
      return { turn: latest ? this.snapshot(sessionId, latest.id) : null, cursor: this.cursor(sessionId), inputs: this.inputs(sessionId), events };
    });
  }

  admit(input: { sessionId: string; requestId: string; runId: string; actor: string; content: unknown; policy: ReviewRules; ifActive?: "error" | "queue" }): TurnSnapshot {
    this.assertDriver(input.sessionId);
    const hashPayload = input.ifActive ? input : { sessionId: input.sessionId, requestId: input.requestId, runId: input.runId, actor: input.actor, content: input.content, policy: input.policy };
    const hash = executionHash(hashPayload);
    return this.transaction(() => {
      this.assertDriver(input.sessionId);
      const existing = this.db.prepare("SELECT id,request_hash FROM session_turns WHERE session_id=? AND request_id=?").get(input.sessionId, input.requestId) as { id: string; request_hash: string } | undefined;
      if (existing) {
        if (existing.request_hash !== hash) throw new ExecutionConflict("Request identity was reused with different input");
        return this.snapshot(input.sessionId, existing.id);
      }
      const isActive = !!this.active(input.sessionId);
      if (isActive && input.ifActive !== "queue") throw new ExecutionConflict("Session already has an active turn");
      if (input.policy.mode === "review_required" && input.policy.expiresAt && !Number.isFinite(Date.parse(input.policy.expiresAt))) {
        throw new ExecutionConflict("Approval deadline must be an absolute timestamp");
      }
      const id = randomUUID(); const at = this.now();
      const state = isActive ? "queued" : "running";
      this.db.prepare(`INSERT INTO session_turns(id,session_id,request_id,request_hash,input_json,actor,state,policy_json,run_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.sessionId, input.requestId, hash, canonicalJson(input.content), input.actor, state, canonicalJson(input.policy), input.runId, at, at);
      if (state === "running") {
        this.db.prepare("INSERT INTO session_run_segments(id,turn_id,state,created_at) VALUES(?,?,'accepted',?)").run(input.runId, id, at);
        this.append(input.sessionId, id, { type: "segment_started" });
      }
      return this.snapshot(input.sessionId, id);
    });
  }

  claim(sessionId: string, turnId: string, owner: string): boolean {
    if (!this.canDrive(sessionId)) return false;
    return this.transaction(() => {
      if (!this.canDrive(sessionId)) return false;
      this.row(sessionId, turnId);
      const changed = this.db.prepare("UPDATE session_turns SET owner=?,owner_process_json=? WHERE id=? AND state='running' AND owner IS NULL").run(owner, this.ownerProcess ? canonicalJson(this.ownerProcess) : null, turnId).changes;
      if (changed) this.db.prepare("UPDATE session_run_segments SET state='running' WHERE id=(SELECT run_id FROM session_turns WHERE id=?) AND state='accepted'").run(turnId);
      return !!changed;
    });
  }

  pause(sessionId: string, turnId: string, owner: string, continuation: ContinuationDescriptor, calls: PermissionRequest[]): TurnSnapshot {
    this.assertDriver(sessionId);
    if (!calls.length || new Set(calls.map((call) => call.id)).size !== calls.length) throw new ExecutionConflict("Invalid pending batch");
    const json = canonicalJson(continuation);
    return this.transaction(() => {
      this.assertDriver(sessionId);
      const row = this.row(sessionId, turnId);
      if (row.state !== "running" || row.owner !== owner) throw new ExecutionConflict("Execution ownership changed");
      const policy = JSON.parse(row.policy_json) as ReviewRules;
      for (const call of calls) {
        this.db.prepare(`INSERT INTO session_interrupts(id,turn_id,run_id,call_id,call_json,status,expires_at)
          VALUES(?,?,?,?,?,'pending',?)`).run(randomUUID(), turnId, row.run_id, call.id, canonicalJson(call), policy.mode === "review_required" ? policy.expiresAt ?? null : null);
      }
      this.db.prepare("UPDATE session_run_segments SET state='interrupted',ended_at=? WHERE id=?").run(this.now(), row.run_id);
      this.db.prepare(`UPDATE session_turns SET state='waiting_for_input',revision=revision+1,
        continuation_json=?,continuation_hash=?,updated_at=? WHERE id=?`).run(json, executionHash(continuation), this.now(), turnId);
      const snapshot = this.snapshot(sessionId, turnId);
      this.append(sessionId, turnId, { type: "segment_interrupted", snapshot });
      return snapshot;
    });
  }

  resolve(input: { sessionId: string; turnId: string; requestId: string; runId: string; actor: string; decisions: ApprovalDecision[]; context?: unknown }): TurnSnapshot {
    this.assertDriver(input.sessionId);
    return this.resolveBatch(input, false);
  }

  /** Compatibility clients vote one call at a time on the authoritative batch. */
  recordRuling(input: { sessionId: string; turnId: string; interruptId: string; decision: ApprovalDecision["decision"]; actor: string }): TurnSnapshot {
    this.assertDriver(input.sessionId);
    return this.transaction(() => {
      this.assertDriver(input.sessionId);
      const row = this.row(input.sessionId, input.turnId);
      const interrupt = this.db.prepare("SELECT * FROM session_interrupts WHERE turn_id=? AND id=?").get(input.turnId, input.interruptId) as InterruptRow | undefined;
      if (!interrupt) throw new ExecutionConflict("Interrupt does not belong to this turn");
      const prior = interrupt.decision_json;
      const decision = canonicalJson(input.decision);
      if (prior !== null) {
        if (prior !== decision) throw new ExecutionConflict("Interrupt already has a different decision");
        return this.snapshot(input.sessionId, input.turnId);
      }
      if (row.state !== "waiting_for_input" || interrupt.status !== "pending") throw new ExecutionConflict("Turn is not waiting for this decision");
      if (interrupt.expires_at && Date.parse(interrupt.expires_at) <= Date.parse(this.now())) throw new ExecutionConflict("Approval deadline has passed");
      this.db.prepare("UPDATE session_interrupts SET decision_json=? WHERE id=?").run(decision, interrupt.id);
      this.append(input.sessionId, input.turnId, { type: "approval_recorded", interruptId: interrupt.id, decision: input.decision, actor: input.actor });
      const pending = this.db.prepare("SELECT * FROM session_interrupts WHERE turn_id=? AND status='pending' ORDER BY rowid").all(input.turnId) as InterruptRow[];
      if (pending.some((item) => item.decision_json === null)) return this.snapshot(input.sessionId, input.turnId);
      return this.resolveBatch({ sessionId: input.sessionId, turnId: input.turnId, requestId: `compat-v1:${row.run_id}`, runId: randomUUID(), actor: input.actor,
        decisions: pending.map((item) => ({ interruptId: item.id, decision: JSON.parse(item.decision_json!) })) }, false);
    });
  }

  pendingRulings(sessionId: string, turnId: string): TurnSnapshot["interrupts"] {
    const snapshot = this.snapshot(sessionId, turnId);
    const voted = new Set((this.db.prepare("SELECT id FROM session_interrupts WHERE turn_id=? AND decision_json IS NOT NULL").all(turnId) as Array<{ id: string }>).map((item) => item.id));
    return snapshot.interrupts.filter((item) => item.status === "pending" && !voted.has(item.id));
  }

  private resolveBatch(input: Parameters<TurnContinuations["resolve"]>[0], expiring: boolean): TurnSnapshot {
    this.assertDriver(input.sessionId);
    const requestHash = executionHash(input);
    const decisionsHash = executionHash([...input.decisions].sort((a, b) => a.interruptId.localeCompare(b.interruptId)));
    return this.transaction(() => {
      this.assertDriver(input.sessionId);
      const row = this.row(input.sessionId, input.turnId);
      const receipt = this.db.prepare("SELECT request_hash FROM session_resolution_receipts WHERE turn_id=? AND request_id=?").get(input.turnId, input.requestId) as { request_hash: string } | undefined;
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new ExecutionConflict("Resolution request identity was reused");
        return this.snapshot(input.sessionId, input.turnId);
      }
      if (row.state !== "waiting_for_input") {
        const equivalent = this.db.prepare("SELECT 1 FROM session_resolution_receipts WHERE turn_id=? AND decisions_hash=?").get(input.turnId, decisionsHash);
        if (equivalent) return this.snapshot(input.sessionId, input.turnId);
        throw new ExecutionConflict("Turn is not waiting for these decisions");
      }
      const pending = this.db.prepare("SELECT * FROM session_interrupts WHERE turn_id=? AND status='pending' ORDER BY rowid").all(input.turnId) as InterruptRow[];
      const submitted = new Map(input.decisions.map((decision) => [decision.interruptId, decision.decision]));
      if (!pending.length || submitted.size !== input.decisions.length || submitted.size !== pending.length || pending.some((item) => !submitted.has(item.id))) {
        throw new ExecutionConflict("Resolve every pending interrupt exactly once");
      }
      const expired = pending.some((item) => item.expires_at && Date.parse(item.expires_at) <= Date.parse(this.now()));
      if (expired && !expiring) throw new ExecutionConflict("Approval deadline has passed");
      if (expiring && !expired) throw new ExecutionConflict("Approval deadline has not passed");
      if (!expiring && pending.some((item) => item.decision_json !== null && item.decision_json !== canonicalJson(submitted.get(item.id)))) throw new ExecutionConflict("Interrupt already has a different decision");
      if (input.runId === row.run_id) throw new ExecutionConflict("Resume requires a new run identity");
      this.db.prepare("INSERT INTO session_run_segments(id,turn_id,state,created_at) VALUES(?,?,'accepted',?)").run(input.runId, input.turnId, this.now());
      for (const item of pending) {
        const decision = submitted.get(item.id)!;
        this.db.prepare("UPDATE session_interrupts SET status=?,decision_json=? WHERE id=? AND status='pending'").run(expiring ? "expired" : decision.allow ? "approved" : "denied", canonicalJson(decision), item.id);
      }
      this.db.prepare("INSERT INTO session_resolution_receipts VALUES(?,?,?,?,?,?,?)").run(input.turnId, input.requestId, requestHash, decisionsHash, input.actor, input.runId, this.now());
      this.db.prepare("UPDATE session_turns SET state='running',run_id=?,revision=revision+1,updated_at=? WHERE id=?").run(input.runId, this.now(), input.turnId);
      this.append(input.sessionId, input.turnId, { type: "resolution_accepted" });
      this.append(input.sessionId, input.turnId, { type: "segment_started" });
      return this.snapshot(input.sessionId, input.turnId);
    });
  }

  expireDue(): TurnSnapshot[] {
    const rows = this.db.prepare("SELECT DISTINCT t.id,t.session_id FROM session_turns t JOIN session_interrupts i ON i.turn_id=t.id WHERE t.state='waiting_for_input' AND i.status='pending' AND i.expires_at IS NOT NULL AND julianday(i.expires_at)<=julianday(?)").all(this.now()) as Array<{ id: string; session_id: string }>;
    return rows.filter(row => this.canDrive(row.session_id)).map((row) => {
      const turn = this.snapshot(row.session_id, row.id);
      return this.resolveBatch({ sessionId: row.session_id, turnId: row.id, requestId: `expiry:${turn.runId}`, runId: randomUUID(), actor: "session-deadline", decisions: turn.interrupts.filter((item) => item.status === "pending").map((item) => ({ interruptId: item.id, decision: { allow: false, reason: "Approval deadline expired" } })) }, true);
    });
  }

  cancel(sessionId: string, turnId: string): TurnSnapshot {
    this.assertDriver(sessionId);
    return this.transaction(() => {
      this.assertDriver(sessionId);
      const row = this.row(sessionId, turnId);
      if (["completed", "failed", "cancelled"].includes(row.state)) return this.snapshot(sessionId, turnId);
      if (row.state === "waiting_for_input" && row.continuation_json && (JSON.parse(row.continuation_json) as ContinuationDescriptor).format === "barry.live.permission") {
        this.db.prepare("UPDATE session_turns SET owner=COALESCE(owner,?) WHERE id=?").run(`cancel:${turnId}`, turnId);
      }
      this.db.prepare("UPDATE session_interrupts SET status='cancelled',decision_json=? WHERE turn_id=? AND status='pending'").run(canonicalJson({ allow: false, reason: "Turn cancelled" }), turnId);
      this.db.prepare("UPDATE session_run_segments SET state='cancelled',ended_at=? WHERE id=? AND state IN ('accepted','running')").run(this.now(), row.run_id);
      this.db.prepare("UPDATE session_turns SET state='cancelled',revision=revision+1,updated_at=? WHERE id=?").run(this.now(), turnId);
      const snapshot = this.snapshot(sessionId, turnId);
      // An already interrupted segment has its terminal event; cancellation
      // changes the logical turn without publishing a second run terminal.
      this.append(sessionId, turnId, { type: ["waiting_for_input", "recovery_required"].includes(row.state) ? "turn_snapshot" : "turn_finished", snapshot });
      return snapshot;
    });
  }

  released(sessionId: string, turnId: string, owner: string): void {
    this.assertDriver(sessionId);
    this.row(sessionId, turnId);
    this.db.prepare("UPDATE session_turns SET owner=NULL WHERE id=? AND owner=?").run(turnId, owner);
  }

  lost(sessionId: string, turnId: string, error: string): TurnSnapshot {
    this.assertDriver(sessionId);
    return this.transaction(() => {
      this.assertDriver(sessionId);
      const row = this.row(sessionId, turnId);
      if (row.state !== "waiting_for_input" && !row.owner) return this.snapshot(sessionId, turnId);
      this.db.prepare("UPDATE session_turns SET state=?,error=?,revision=revision+1,updated_at=? WHERE id=?").run(row.state === "waiting_for_input" ? "recovery_required" : row.state, error, this.now(), turnId);
      const snapshot = this.snapshot(sessionId, turnId);
      this.append(sessionId, turnId, { type: "turn_snapshot", snapshot });
      return snapshot;
    });
  }

  continuation(sessionId: string, turnId: string): ContinuationDescriptor {
    const row = this.row(sessionId, turnId);
    if (!row.continuation_json) throw new ExecutionRecoveryRequired("Missing continuation");
    const value = JSON.parse(row.continuation_json) as ContinuationDescriptor;
    if (executionHash(value) !== row.continuation_hash) throw new ExecutionRecoveryRequired("Corrupt continuation");
    return value;
  }

  conversation(sessionId: string): ContinuationDescriptor | undefined {
    const last = this.db.prepare("SELECT id FROM session_turns WHERE session_id=? AND state='completed' AND continuation_json IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
    return last ? this.continuation(sessionId, last.id) : undefined;
  }

  decisions(sessionId: string, turnId: string): Map<string, import("@barry-rocks/sdk/sessions").PermissionDecision> {
    const row = this.row(sessionId, turnId);
    const checkpoint = this.continuation(sessionId, turnId);
    void checkpoint;
    const lastRun = this.db.prepare("SELECT run_id FROM session_interrupts WHERE turn_id=? ORDER BY rowid DESC LIMIT 1").get(row.id) as { run_id: string } | undefined;
    const items = this.db.prepare("SELECT call_id,decision_json FROM session_interrupts WHERE turn_id=? AND run_id=?").all(turnId, lastRun?.run_id) as InterruptRow[];
    if (!items.length || items.some((item) => !item.decision_json)) throw new ExecutionConflict("Unresolved batch");
    return new Map(items.map((item) => [item.call_id, JSON.parse(item.decision_json!)]));
  }

  recorded(sessionId: string, turnId: string, call: PermissionRequest): RecordedCallResult | undefined {
    this.row(sessionId, turnId);
    const outcome = this.db.prepare("SELECT call_hash,state,outcome_json FROM session_call_outcomes WHERE turn_id=? AND call_id=?").get(turnId, call.id) as { call_hash: string; state: string; outcome_json: string | null } | undefined;
    if (!outcome) return undefined;
    if (outcome.call_hash !== executionHash(call)) throw new ExecutionConflict("Call identity reused");
    if (!outcome.outcome_json) throw new ExecutionRecoveryRequired("Tool effect outcome is uncertain; reconciliation is required");
    return JSON.parse(outcome.outcome_json) as RecordedCallResult;
  }

  denied(sessionId: string, turnId: string, owner: string, call: PermissionRequest, outcome: RecordedCallResult): RecordedCallResult {
    this.assertDriver(sessionId);
    return this.transaction(() => {
      this.assertDriver(sessionId);
      const row = this.row(sessionId, turnId);
      if (row.owner !== owner || row.state !== "running") throw new ExecutionConflict("Execution ownership changed");
      const proposed = this.db.prepare("SELECT call_json FROM session_interrupts WHERE turn_id=? AND call_id=?").get(turnId, call.id) as { call_json: string } | undefined;
      if (!proposed || executionHash(JSON.parse(proposed.call_json)) !== executionHash(call)) throw new ExecutionConflict("Denial differs from original proposal");
      const existing = this.recorded(sessionId, turnId, call); if (existing) return existing;
      this.db.prepare("INSERT INTO session_call_outcomes VALUES(?,?,?,'denied',?,?)").run(turnId, call.id, executionHash(call), canonicalJson(outcome), owner);
      return outcome;
    });
  }

  async execute(sessionId: string, turnId: string, owner: string, call: PermissionRequest, effect: () => Promise<RecordedCallResult>): Promise<RecordedCallResult> {
    this.assertDriver(sessionId);
    const prior = this.transaction(() => {
      this.assertDriver(sessionId);
      const row = this.row(sessionId, turnId);
      if (row.state !== "running" || row.owner !== owner) throw new ExecutionConflict("Execution ownership changed");
      const proposed = this.db.prepare("SELECT call_json,status FROM session_interrupts WHERE turn_id=? AND call_id=?").get(turnId, call.id) as { call_json: string; status: string } | undefined;
      if (!proposed || proposed.status !== "approved" || executionHash(JSON.parse(proposed.call_json)) !== executionHash(call)) throw new ExecutionConflict("Effect differs from approved proposal");
      const previous = this.db.prepare("SELECT state,call_hash,outcome_json FROM session_call_outcomes WHERE turn_id=? AND call_id=?").get(turnId, call.id) as { state: string; call_hash: string; outcome_json: string | null } | undefined;
      if (previous) {
        if (previous.call_hash !== executionHash(call)) throw new ExecutionConflict("Call identity reused");
        if (previous.outcome_json) return JSON.parse(previous.outcome_json) as RecordedCallResult;
        throw new ExecutionRecoveryRequired("Tool effect outcome is uncertain; reconciliation is required");
      }
      this.db.prepare("INSERT INTO session_call_outcomes VALUES(?,?,?,'executing',NULL,?)").run(turnId, call.id, executionHash(call), owner);
      return null;
    });
    if (prior) return prior;
    let outcome: RecordedCallResult;
    try { outcome = await effect(); }
    catch (error) {
      this.db.prepare("UPDATE session_call_outcomes SET state='uncertain' WHERE turn_id=? AND call_id=? AND owner=?").run(turnId, call.id, owner);
      throw new ExecutionRecoveryRequired(`Effect did not return a durable outcome: ${String(error)}`);
    }
    if (outcome.id !== call.id) throw new ExecutionRecoveryRequired("Tool returned an unrelated outcome");
    this.db.prepare("UPDATE session_call_outcomes SET state=?,outcome_json=? WHERE turn_id=? AND call_id=? AND owner=? AND state='executing'").run(outcome.error ? "failed" : "completed", canonicalJson(outcome), turnId, call.id, owner);
    return outcome;
  }

  append(sessionId: string, turnId: string, event: unknown): number {
    this.assertDriver(sessionId);
    const row = this.row(sessionId, turnId);
    const sequence=Number(this.db.prepare("INSERT INTO session_execution_events(session_id,turn_id,run_id,event_json,created_at) VALUES(?,?,?,?,?)").run(sessionId, turnId, row.run_id, canonicalJson(event), this.now()).lastInsertRowid);
    queueMicrotask(()=>{for (const listener of eventListeners.get(sessionId)??[]) listener();});
    return sequence;
  }

  replay(sessionId: string, after = 0, limit = 256, inclusive = false): Array<{ sequence: number; turnId: string; runId: string; event: unknown }> {
    if (!Number.isSafeInteger(after) || after < 0) throw new ExecutionConflict("Invalid replay cursor");
    if (after && !this.db.prepare("SELECT 1 FROM session_execution_events WHERE session_id=? AND sequence=?").get(sessionId, after)) throw new ExecutionConflict("Replay cursor does not belong to this session");
    const rows = this.db.prepare(`SELECT sequence,turn_id,run_id,event_json FROM session_execution_events WHERE session_id=? AND sequence${inclusive ? ">=" : ">"}? ORDER BY sequence LIMIT ?`).all(sessionId, after, Math.min(Math.max(limit, 1), 1024)) as Array<{ sequence: number; turn_id: string; run_id: string; event_json: string }>;
    return rows.map((row) => ({ sequence: row.sequence, turnId: row.turn_id, runId: row.run_id, event: JSON.parse(row.event_json) }));
  }

  /** Metadata-only recovery, called inside destination proof/receipt settlement.
   * Never admits, claims, dispatches, authorizes, or executes a continuation. */
  recoverWorkflowOutcome(input: { sessionId: string; turnId: string; segmentId: string; owner: string; expectedRevision: number; outcome: SegmentOutcome }): TurnSnapshot {
    this.assertDriver(input.sessionId);
    if (!this.access.workflowBinding) throw new ExecutionConflict("Workflow recovery requires its destination capability");
    return this.transaction(() => {
      this.assertDriver(input.sessionId);
      const row = this.row(input.sessionId, input.turnId), outcome = input.outcome;
      if (row.run_id !== input.segmentId || row.revision !== input.expectedRevision || row.owner !== null && row.owner !== input.owner) throw new ExecutionConflict("Workflow recovery revision or ownership changed");
      if (this.db.prepare("SELECT 1 FROM session_call_outcomes WHERE turn_id=? AND state IN ('executing','uncertain')").get(input.turnId)) throw new ExecutionRecoveryRequired("Tool effect outcome remains uncertain");
      const same = (left: unknown, right: unknown) => executionHash(left) === executionHash(right);
      if (row.state === "completed") {
        if (outcome.type !== "completed" || !same(row.result_json === null ? null : JSON.parse(row.result_json), outcome.result ?? null)
          || outcome.conversation !== undefined && !same(row.continuation_json === null ? null : JSON.parse(row.continuation_json), outcome.conversation)) throw new ExecutionConflict("Workflow terminal outcome conflict");
        return this.snapshot(input.sessionId, input.turnId);
      }
      if (row.state === "failed") {
        if (outcome.type !== "failed" || row.error !== outcome.error) throw new ExecutionConflict("Workflow terminal outcome conflict");
        return this.snapshot(input.sessionId, input.turnId);
      }
      if (row.state === "waiting_for_input") {
        const calls = this.db.prepare("SELECT call_json FROM session_interrupts WHERE turn_id=? AND run_id=? ORDER BY rowid").all(input.turnId, input.segmentId) as { call_json: string }[];
        if (outcome.type !== "interrupted" || !same(row.continuation_json === null ? null : JSON.parse(row.continuation_json), outcome.continuation)
          || !same(calls.map(call => JSON.parse(call.call_json)), outcome.calls)) throw new ExecutionConflict("Workflow checkpoint outcome conflict");
        this.released(input.sessionId, input.turnId, input.owner);
        return this.snapshot(input.sessionId, input.turnId);
      }
      if (row.state !== "running" && row.state !== "recovery_required") throw new ExecutionConflict("Workflow turn is not recoverable");
      if (this.db.prepare("SELECT 1 FROM session_interrupts WHERE turn_id=? AND run_id=?").get(input.turnId, input.segmentId)) throw new ExecutionConflict("Workflow checkpoint already has conflicting interrupts");
      // Historic ownership exists only within this writer transaction. No
      // runnable scan or execution callback can adopt it before settlement.
      this.db.prepare("UPDATE session_turns SET state='running',owner=? WHERE id=?").run(input.owner, input.turnId);
      let repaired: TurnSnapshot;
      if (outcome.type === "interrupted") repaired = this.pause(input.sessionId, input.turnId, input.owner, outcome.continuation, outcome.calls);
      else repaired = this.finish(input.sessionId, input.turnId, input.owner, outcome.type === "failed" ? { state: "failed", error: outcome.error }
        : { state: "completed", ...(outcome.result === undefined ? {} : { result: outcome.result }), ...(outcome.conversation ? { conversation: outcome.conversation } : {}) });
      this.released(input.sessionId, input.turnId, input.owner);
      return repaired;
    });
  }

  finish(sessionId: string, turnId: string, owner: string, outcome: { state: "completed" | "failed" | "recovery_required"; result?: unknown; error?: string; conversation?: ContinuationDescriptor }): TurnSnapshot {
    this.assertDriver(sessionId);
    return this.transaction(() => {
      this.assertDriver(sessionId);
      const row = this.row(sessionId, turnId);
      if (row.owner !== owner || row.state !== "running") throw new ExecutionConflict("Execution ownership changed");
      this.db.prepare("UPDATE session_run_segments SET state=?,ended_at=? WHERE id=?").run(outcome.state === "completed" ? "completed" : "failed", this.now(), row.run_id);
      this.db.prepare("UPDATE session_turns SET state=?,owner=NULL,result_json=?,error=?,revision=revision+1,updated_at=? WHERE id=?").run(outcome.state, outcome.result === undefined ? null : canonicalJson(outcome.result), outcome.error ?? null, this.now(), turnId);
      if (outcome.conversation) this.db.prepare("UPDATE session_turns SET continuation_json=?,continuation_hash=? WHERE id=?").run(canonicalJson(outcome.conversation), executionHash(outcome.conversation), turnId);
      const snapshot = this.snapshot(sessionId, turnId);
      this.append(sessionId, turnId, { type: "turn_finished", snapshot });
      return snapshot;
    });
  }
}
