import { z } from "zod";
import { scopeFingerprint, executionScopeSchema, type ExecutionScope } from "../bounds/execution-scope.js";
import { encodeEffectJson } from "../tools/effect-json.js";

export type TurnState = { state: "active" | "uncertain" | "interrupted" } | { state: "complete"; result: unknown };
export type WorkflowSessionTurnStatus = "admitted" | "active" | "uncertain" | "interrupting" | "interrupted" | "complete";
export interface WorkflowSessionBindingRecord { key: string; requestHash: string; sessionId: string; identity: string; scopeHash: string; state: "admitted" | "ready" }
export interface WorkflowSessionTurnRecord { key: string; sessionId: string; requestHash: string; state: WorkflowSessionTurnStatus; result: string | null }
/** Persistence is injected from Sessions so the coordinator never opens its store itself. */
export interface WorkflowSessionJournalStore {
  getBinding(key: string): Promise<WorkflowSessionBindingRecord | undefined>;
  getBindingBySession(sessionId: string): Promise<WorkflowSessionBindingRecord | undefined>;
  admitBinding(record: WorkflowSessionBindingRecord): Promise<boolean>;
  readyBinding(key: string): Promise<void>;
  getTurn(key: string): Promise<WorkflowSessionTurnRecord | undefined>;
  /** Atomically enforces both unique turn keys and one active turn per session. */
  admitTurn(record: WorkflowSessionTurnRecord): Promise<boolean>;
  updateTurn(key: string, state: WorkflowSessionTurnStatus, result?: string): Promise<WorkflowSessionTurnStatus>;
}
export interface WorkflowSessionBackend {
  lookupSession(id: string): Promise<{ identity: string; scopeFingerprint: string } | undefined>;
  createSession(request: { id: string; identity: string; scope: ExecutionScope }): Promise<void>;
  lookupTurn(sessionId: string, turnId: string): Promise<TurnState | undefined>;
  runTurn(request: { sessionId: string; turnId: string; input: unknown; scope: ExecutionScope }): Promise<unknown>;
  interruptTurn(sessionId: string, turnId: string): Promise<boolean>;
  enforceable(scope: ExecutionScope): boolean;
}
export class SessionReconciliationRequired extends Error {
  constructor(options?: ErrorOptions) { super("OutcomeUnknown: reconcile the existing session turn before starting another", options); }
}

/** Stable destination reference, available before any external resource is acquired. */
export function workflowSessionId(key: string, identity: string): string {
  z.string().min(1).max(500).parse(key);
  z.string().min(1).max(200).parse(identity);
  return `job-${scopeFingerprint({ key, identity }).slice(0, 40)}`;
}

/** Sessions owns this journal and the supplied backend's harness processes. */
export class WorkflowSessionTurns {
  constructor(private readonly store: WorkflowSessionJournalStore, private readonly backend: WorkflowSessionBackend) {}
  private validate(scope: ExecutionScope): string {
    scope = executionScopeSchema.parse(scope);
    if (!scope.identity) throw new Error("session-backed jobs require an identity");
    const { fingerprint, ...evidence } = scope;
    if (scopeFingerprint(evidence) !== fingerprint || !this.backend.enforceable(scope)) throw new Error("session scope is invalid or cannot be enforced");
    return scope.identity;
  }
  async ensure(key: string, scope: ExecutionScope, existingSessionId?: string): Promise<string> {
    z.string().min(1).max(500).parse(key);
    const identity = this.validate(scope);
    const id = existingSessionId ?? workflowSessionId(key, identity);
    const hash = scopeFingerprint({ key, identity, scope, existingSessionId });
    const before = await this.store.getBinding(key);
    if (before && (before.requestHash !== hash || before.sessionId !== id)) throw new Error("session binding request conflict");
    const found = await this.backend.lookupSession(id);
    if (found && (found.identity !== identity || found.scopeFingerprint !== scope.fingerprint)) throw new Error("session identity or execution ceiling mismatch");
    if (existingSessionId && !found) throw new Error("session to attach does not exist");
    if (before) {
      if (!found) throw new SessionReconciliationRequired();
      await this.store.readyBinding(key);
      return before.sessionId;
    }
    const inserted = await this.store.admitBinding({ key, requestHash: hash, sessionId: id, identity, scopeHash: scope.fingerprint, state: "admitted" });
    if (!inserted) {
      // Another process committed the intent after our initial read. Do not
      // recursively race its external createSession call: an absent resource
      // at this instant is an unknown outcome, not permission to admit again.
      const winner = await this.store.getBinding(key);
      if (!winner || winner.requestHash !== hash || winner.sessionId !== id) throw new Error("session binding request conflict");
      if (!found) throw new SessionReconciliationRequired();
      await this.store.readyBinding(key);
      return winner.sessionId;
    }
    if (!found) {
      try { await this.backend.createSession({ id, identity, scope }); }
      catch (error) { throw new SessionReconciliationRequired({ cause: error }); }
    }
    const verified = await this.backend.lookupSession(id);
    if (!verified || verified.identity !== identity || verified.scopeFingerprint !== scope.fingerprint) throw new SessionReconciliationRequired();
    await this.store.readyBinding(key);
    return id;
  }
  async turn(key: string, sessionId: string, input: unknown, scope: ExecutionScope): Promise<unknown> {
    z.string().min(1).max(500).parse(key); this.validate(scope);
    const binding = await this.store.getBindingBySession(sessionId);
    if (!binding || binding.state !== "ready" || binding.identity !== scope.identity || binding.scopeHash !== scope.fingerprint) throw new Error("turn has no matching approved session binding");
    // The journal alone cannot establish the live session's identity/ceiling.
    // Check the destination even for completed receipt reads.
    const session = await this.backend.lookupSession(sessionId);
    if (!session) throw new SessionReconciliationRequired();
    if (session.identity !== scope.identity || session.scopeFingerprint !== scope.fingerprint) throw new Error("session identity or execution ceiling mismatch");
    encodeEffectJson(input);
    const hash = scopeFingerprint({ sessionId, input, scope });
    const before = await this.store.getTurn(key);
    if (before) {
      if (before.requestHash !== hash) throw new Error("turn request conflict");
      if (before.state === "complete") return JSON.parse(before.result!);
      const observed = await this.backend.lookupTurn(sessionId, key);
      if (observed?.state === "complete") return this.complete(key, observed.result);
      if (observed?.state === "interrupted") await this.store.updateTurn(key, "interrupted");
      throw new SessionReconciliationRequired();
    }
    const admitted = await this.store.admitTurn({ key, sessionId, requestHash: hash, state: "admitted", result: null });
    if (!admitted) {
      const raced = await this.store.getTurn(key);
      if (raced) {
        if (raced.requestHash !== hash) throw new Error("turn request conflict");
        const observed = await this.backend.lookupTurn(sessionId, key);
        if (observed?.state === "complete") return this.complete(key, observed.result);
        throw new SessionReconciliationRequired();
      }
      throw new Error("SessionBusy: another turn owns this session");
    }
    if (await this.store.updateTurn(key, "active") !== "active") throw new SessionReconciliationRequired();
    try { return await this.complete(key, await this.backend.runTurn({ sessionId, turnId: key, input, scope })); }
    catch (error) {
      await this.store.updateTurn(key, "uncertain");
      throw new SessionReconciliationRequired({ cause: error });
    }
  }
  private async complete(key: string, value: unknown): Promise<unknown> {
    const result = encodeEffectJson(value ?? null);
    if (await this.store.updateTurn(key, "complete", result) !== "complete") throw new SessionReconciliationRequired();
    return JSON.parse(result);
  }
  async interrupt(key: string): Promise<boolean> {
    const row = await this.store.getTurn(key);
    if (!row) return false;
    if (["complete", "interrupted"].includes(String(row.state))) return true;
    const interrupting = await this.store.updateTurn(key, "interrupting");
    if (interrupting === "complete" || interrupting === "interrupted") return true;
    const acknowledged = await this.backend.interruptTurn(row.sessionId, key);
    const observed = await this.backend.lookupTurn(row.sessionId, key);
    if (observed?.state === "complete") { await this.complete(key, observed.result); return true; }
    if (acknowledged && observed?.state === "interrupted") {
      const final = await this.store.updateTurn(key, "interrupted");
      return final === "interrupted" || final === "complete";
    }
    return false;
  }
  inspect(key: string) { return this.store.getTurn(key); }
}
