import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PayloadLimit } from "./types.js";

export class WorkflowError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly retryable = false) { super(message); }
}
type SqliteFault = { code?: string; errcode?: number; message?: string };
function sqliteFault(error: SqliteFault | null): boolean {
  return Boolean(error?.code?.startsWith("ERR_SQLITE") || error?.code?.startsWith("SQLITE_") || typeof error?.errcode === "number");
}
function sqlitePrimary(error: SqliteFault | null): number {
  if (typeof error?.errcode === "number") return error.errcode & 255;
  const primary = error?.code?.split("_")[1];
  return primary === "BUSY" ? 5 : primary === "LOCKED" ? 6 : primary === "CORRUPT" ? 11 : primary === "NOTADB" ? 26 : 0;
}
export function publicError(error: unknown) {
  const requestId = randomUUID();
  if (error instanceof WorkflowError) return { status: error.status, body: { code: error.code, message: error.message, error: error.message, retryable: error.retryable, requestId } };
  if (error instanceof PayloadLimit) return { status: 413, body: { code: "PayloadTooLarge", message: error.message, error: error.message, retryable: false, requestId } };
  const fault = error as { code?: string; errcode?: number; message?: string } | null;
  if (sqliteFault(fault)) {
    const primary = sqlitePrimary(fault), busy = primary === 5 || primary === 6;
    return { status: 503, body: { code: busy ? "StoreBusy" : "StoreUnavailable", message: "Workflow storage is unavailable; retry with the same request ID.", error: "Workflow storage is unavailable; retry with the same request ID.", retryable: true, requestId, retryAfterMs: busy ? 250 : 5000 } };
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError || (error instanceof TypeError && fault?.code === "ERR_INVALID_URL")) return { status: 400, body: { code: "InvalidRequest", message: "Invalid request.", error: "Invalid request.", retryable: false, requestId } };
  // Legacy domain errors are translated here until all call sites use WorkflowError.
  const message = fault?.message ?? "";
  const status = /unknown workflow|unknown command/.test(message) ? 404 : /conflict|different|stale workflow revision|only blocked|workflow is closed/.test(message) ? 409 : /limit reached|capacity reached/.test(message) ? 429 : /invalid |unknown workflow definition|must be|obsolete|negotiation required/.test(message) ? 400 : 500;
  const safe = status === 500 ? "Workflow operation failed." : message;
  return { status, body: { code: status === 404 ? "NotFound" : status === 409 ? "Conflict" : status === 429 ? "CapacityExceeded" : status === 500 ? "InternalError" : "InvalidRequest", message: safe, error: safe, retryable: status === 429 || status === 500, requestId } };
}

/** One probe for the entire service, never one hot retry for each pending run. */
export class StorageHealth {
  private failures = 0;
  private probeAt = 0;
  private recoveryRequired = false;
  get ready(): boolean { return this.failures === 0; }
  get state(): string { return this.ready ? "ready" : this.recoveryRequired ? "recovery_required" : "degraded"; }
  observe(error: unknown): void {
    const fault = error as { code?: string; errcode?: number } | null;
    if (!sqliteFault(fault) && !(error instanceof WorkflowError && ["StoreUnavailable", "StoreRecoveryRequired"].includes(error.code))) return;
    const code = sqlitePrimary(fault);
    this.recoveryRequired ||= code === 11 || code === 26 || fault?.code === "StoreRecoveryRequired";
    this.failures++;
    this.probeAt = performance.now() + Math.min(30_000, 1000 * 2 ** Math.min(5, this.failures - 1));
  }
  probe(check: () => void): void {
    if (this.ready || this.recoveryRequired || performance.now() < this.probeAt) return;
    try { check(); this.failures = 0; } catch (error) { this.observe(error); }
  }
}
