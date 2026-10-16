/** Aggregate physical evidence for a Work-owned Sessions turn. No model input,
 * credentials or logical outcome decoding occurs here. */
import type Database from "better-sqlite3";
import { boundFingerprint } from "@barry-rocks/sdk/bounds";
import type { WorkflowDestinationBinding } from "@barry-rocks/sessions-bag/store/workflow-destinations";
import type { SessionsWorkflowBackend } from "./workflow-session-backend.js";
import { observeWorkflowPhysicalRecovery } from "./workflow-process-recovery.js";
import { workflowWorkSegmentExcluded } from "./workflow-work-input-fence.js";

export interface WorkflowWorkPhysical {
  state: "unknown" | "ceased";
  terminal: boolean;
  allNotStarted: boolean;
  turnId: string | null;
  segments: number;
}
const unknown = (): WorkflowWorkPhysical => ({ state: "unknown", terminal: false, allNotStarted: false, turnId: null, segments: 0 });
export function inspectWorkflowWorkPhysical(db: Database.Database, backend: Pick<SessionsWorkflowBackend, "destination">, declaration: WorkflowDestinationBinding, key: string): WorkflowWorkPhysical {
  const destination = backend.destination, found = destination.inspect(key);
  if (!found) return unknown();
  if (found.sessionId !== declaration.sessionId) throw new Error("WorkSessionPhysicalBindingConflict");
  const retained = destination.lookupSession(found.sessionId);
  if (!retained || retained.bindingKey !== declaration.bindingKey || retained.identity !== declaration.identity
    || boundFingerprint({ ...retained, boundFingerprint: undefined }) !== boundFingerprint(declaration)) throw new Error("WorkSessionPhysicalBindingConflict");
  // Repair physical proof independently from malformed result/checkpoint JSON.
  // No PID signal/adoption: the existing observer proves exact native absence.
  const intent = db.prepare("SELECT request_hash FROM session_workflow_turns WHERE key=? AND session_id=?").get(key, found.sessionId) as { request_hash: string } | undefined;
  const logical = db.prepare("SELECT revision FROM session_turns WHERE id=? AND session_id=?").get(found.turnId, found.sessionId) as { revision: number } | undefined;
  if (!intent || !logical) return unknown();
  for (const fence of destination.settlements(found.turnId)) {
    if (fence.ceasedAt !== null || fence.handle === null) continue;
    const proof = observeWorkflowPhysicalRecovery({ declaration, key, fence, originalIntentHash: intent.request_hash, revision: logical.revision });
    if (proof) destination.settlePhysical({ bindingKey: declaration.bindingKey, key, sessionId: found.sessionId, turnId: found.turnId,
      segmentId: fence.segmentId, owner: fence.owner, expectedRevision: logical.revision, proof });
  }
  return db.transaction(() => {
    const mapped = destination.inspect(key), current = destination.lookupSession(found.sessionId);
    if (!mapped || boundFingerprint(mapped) !== boundFingerprint(found) || !current || current.bindingKey !== declaration.bindingKey
      || boundFingerprint({ ...current, boundFingerprint: undefined }) !== boundFingerprint(declaration)) return unknown();
    const currentIntent = db.prepare("SELECT request_hash FROM session_workflow_turns WHERE key=? AND session_id=?").get(key, found.sessionId) as { request_hash: string } | undefined;
    if (!currentIntent || currentIntent.request_hash !== intent.request_hash) return unknown();
    const turn = db.prepare("SELECT state,revision,run_id FROM session_turns WHERE id=? AND session_id=?").get(found.turnId, found.sessionId) as { state: string; revision: number; run_id: string } | undefined;
    if (!turn) return unknown();
    const segments = db.prepare(`SELECT s.id,f.session_id,f.turn_id,f.phase,f.ceased_at
      FROM session_run_segments s LEFT JOIN session_workflow_settlements f ON f.segment_id=s.id
      WHERE s.turn_id=? ORDER BY s.rowid`).all(found.turnId) as { id: string; session_id: string | null; turn_id: string | null; phase: string | null; ceased_at: string | null }[];
    const orphan = db.prepare(`SELECT 1 FROM session_workflow_settlements f LEFT JOIN session_run_segments s ON s.id=f.segment_id
      WHERE f.turn_id=? AND (s.id IS NULL OR s.turn_id<>f.turn_id OR f.session_id<>?) LIMIT 1`).get(found.turnId, found.sessionId);
    const excluded = new Set(segments.filter(segment => segment.phase === null && workflowWorkSegmentExcluded(db, declaration, key, found.turnId, segment.id, currentIntent.request_hash)).map(segment => segment.id));
    const complete = segments.length > 0 && segments.some(segment => segment.id === turn.run_id) && !orphan
      && segments.every(segment => excluded.has(segment.id) || segment.session_id === found.sessionId && segment.turn_id === found.turnId
        && (segment.phase === "ceased" || segment.phase === "not_started") && segment.ceased_at !== null);
    return { state: complete ? "ceased" as const : "unknown" as const, terminal: ["completed", "cancelled", "failed"].includes(turn.state),
      allNotStarted: complete && segments.every(segment => segment.phase === "not_started" || excluded.has(segment.id)), turnId: found.turnId, segments: segments.length };
  })();
}
