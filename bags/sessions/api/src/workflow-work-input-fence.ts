/** Durable exclusion of future Sessions input. This proof is neither a logical
 * result nor native cessation evidence for a process that may have existed. */
import type Database from "better-sqlite3";
import { z } from "zod";
import { boundFingerprint } from "@barry-rocks/sdk/bounds";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { WorkflowDestinations, validatedWorkflowDestinationScope, workflowDestinationSelectionSchema,
  type WorkflowDestinationBinding } from "@barry-rocks/sessions-bag/store/workflow-destinations";

const ref = z.string().min(1).max(500), hash = z.string().regex(/^[a-f0-9]{64}$/);
const proofSchema = z.strictObject({ version: z.literal(1), key: ref, bindingKey: ref, sessionId: ref,
  declarationHash: hash, intentHash: hash, neverStarted: z.boolean(), recordedAt: z.number().int().positive() });
type ProofRow = { key: string; binding_key: string; session_id: string; declaration_hash: string;
  never_started: number; proof_hash: string; proof_json: string };
const segmentProofSchema = z.strictObject({ version: z.literal(1), neverClaimed: z.literal(true), key: ref, bindingKey: ref,
  sessionId: ref, turnId: ref, segmentId: ref, declarationHash: hash, intentHash: hash, recordedAt: z.number().int().positive() });
type SegmentProofRow = { segment_id: string; key: string; binding_key: string; session_id: string; turn_id: string;
  declaration_hash: string; intent_hash: string; proof_hash: string; proof_json: string };

function segmentProofMatches(row: SegmentProofRow, declaration: WorkflowDestinationBinding, key: string, turnId: string, segmentId: string, intentHash: string): boolean {
  const parsed = segmentProofSchema.safeParse(JSON.parse(row.proof_json));
  if (!parsed.success) return false;
  const proof = parsed.data, declarationHash = boundFingerprint(declaration);
  return row.segment_id === segmentId && row.key === key && row.binding_key === declaration.bindingKey && row.session_id === declaration.sessionId
    && row.turn_id === turnId && row.declaration_hash === declarationHash && row.intent_hash === intentHash
    && proof.segmentId === segmentId && proof.key === key && proof.bindingKey === declaration.bindingKey && proof.sessionId === declaration.sessionId
    && proof.turnId === turnId && proof.declarationHash === declarationHash && proof.intentHash === intentHash && boundFingerprint(proof) === row.proof_hash;
}

/** Affirmative exclusion recorded under the native claim writer lock. A missing
 * settlement alone never satisfies this predicate. It does not assert that a
 * previously prepared process ceased, and cannot replace any historical fence. */
export function workflowWorkSegmentExcluded(db: Database.Database, declaration: WorkflowDestinationBinding, key: string, turnId: string, segmentId: string, expectedRequestHash: string): boolean {
  if (declaration.bindingKey !== `work-session:${key}` || declaration.sessionId !== workflowSessionId(declaration.bindingKey, declaration.identity)
    || !db.prepare("SELECT 1 FROM session_workflow_destination_cancellations WHERE key=?").get(key)
    || db.prepare("SELECT 1 FROM session_workflow_settlements WHERE segment_id=?").get(segmentId)) return false;
  const mapping = db.prepare("SELECT session_id,turn_id FROM session_workflow_destination_turns WHERE key=?").get(key) as { session_id: string; turn_id: string } | undefined;
  const intent = db.prepare("SELECT session_id,request_hash FROM session_workflow_turns WHERE key=?").get(key) as { session_id: string; request_hash: string } | undefined;
  const segment = db.prepare("SELECT s.turn_id,t.session_id FROM session_run_segments s JOIN session_turns t ON t.id=s.turn_id WHERE s.id=?").get(segmentId) as { turn_id: string; session_id: string } | undefined;
  if (!mapping || mapping.session_id !== declaration.sessionId || mapping.turn_id !== turnId || !intent || intent.session_id !== declaration.sessionId
    || intent.request_hash !== expectedRequestHash || !segment || segment.turn_id !== turnId || segment.session_id !== declaration.sessionId) return false;
  const destination = new WorkflowDestinations(db).lookupSession(declaration.sessionId);
  if (!destination) return false;
  const { boundFingerprint: _fingerprint, ...retained } = destination;
  if (boundFingerprint(retained) !== boundFingerprint(declaration)) return false;
  const whole = db.prepare("SELECT * FROM session_workflow_work_input_fences WHERE key=?").get(key) as ProofRow | undefined;
  if (!whole || whole.binding_key !== declaration.bindingKey || whole.session_id !== declaration.sessionId || whole.declaration_hash !== boundFingerprint(declaration)) return false;
  const wholeParsed = proofSchema.safeParse(JSON.parse(whole.proof_json));
  if (!wholeParsed.success || boundFingerprint(wholeParsed.data) !== whole.proof_hash || whole.never_started !== Number(wholeParsed.data.neverStarted)
    || wholeParsed.data.key !== key || wholeParsed.data.bindingKey !== declaration.bindingKey || wholeParsed.data.sessionId !== declaration.sessionId
    || wholeParsed.data.declarationHash !== boundFingerprint(declaration) || wholeParsed.data.intentHash !== expectedRequestHash) return false;
  const row = db.prepare("SELECT * FROM session_workflow_work_segment_exclusions WHERE segment_id=?").get(segmentId) as SegmentProofRow | undefined;
  return row !== undefined && segmentProofMatches(row, declaration, key, turnId, segmentId, expectedRequestHash);
}

/** The managed Sessions schema installs the append-only proof table. No runtime
 * DDL, process signalling, credential read or turn/result decoding occurs here. */
export function fenceWorkflowWorkInput(db: Database.Database, supplied: WorkflowDestinationBinding, key: string, expectedRequestHash: string): { neverStarted: boolean } {
  const declaration = structuredClone(supplied), scope = validatedWorkflowDestinationScope(declaration.scope);
  workflowDestinationSelectionSchema.parse(declaration.selection);ref.parse(key);hash.parse(expectedRequestHash);
  if (declaration.bindingKey !== `work-session:${key}` || declaration.identity !== scope.identity
    || declaration.sessionId !== workflowSessionId(declaration.bindingKey, declaration.identity)
    || !Number.isSafeInteger(declaration.identityId) || declaration.identityId <= 0
    || !Number.isSafeInteger(declaration.actorId) || declaration.actorId <= 0) throw new Error("WorkSessionsInputFenceBindingConflict");
  const declarationHash = boundFingerprint(declaration);
  return db.transaction(() => {
    // Check every existing owner of this key/session before the tombstone. The
    // writer lock is the same exclusion used by destination admission/claim.
    const binding = db.prepare("SELECT key,session_id,identity,scope_hash,request_hash FROM session_workflow_bindings WHERE key=? OR session_id=?").all(declaration.bindingKey, declaration.sessionId) as { key: string; session_id: string; identity: string; scope_hash: string; request_hash: string }[];
    const bindingHash = boundFingerprint({ key: declaration.bindingKey, identity: declaration.identity, scope: declaration.scope, existingSessionId: undefined });
    if (binding.some(row => row.key !== declaration.bindingKey || row.session_id !== declaration.sessionId || row.identity !== declaration.identity
      || row.scope_hash !== scope.fingerprint || row.request_hash !== bindingHash)) throw new Error("WorkSessionsInputFenceBindingConflict");
    const destination = new WorkflowDestinations(db);
    const declared = destination.lookupSession(declaration.sessionId);
    if (declared) {
      const { boundFingerprint: _fingerprint, ...retained } = declared;
      if (boundFingerprint(retained) !== declarationHash) throw new Error("WorkSessionsInputFenceBindingConflict");
    } else if (db.prepare("SELECT 1 FROM session_workflow_destinations WHERE binding_key=? OR session_id=?").get(declaration.bindingKey, declaration.sessionId)
      || db.prepare("SELECT 1 FROM sessions WHERE id=?").get(declaration.sessionId)) throw new Error("WorkSessionsInputFenceBindingConflict");
    const intents = db.prepare("SELECT key,session_id,request_hash FROM session_workflow_turns WHERE key=? OR session_id=?").all(key, declaration.sessionId) as { key: string; session_id: string; request_hash: string }[];
    if (intents.some(row => row.key !== key || row.session_id !== declaration.sessionId || row.request_hash !== expectedRequestHash) || intents.length && !declared) throw new Error("WorkSessionsInputFenceBindingConflict");
    const mappings = db.prepare("SELECT key,session_id,turn_id FROM session_workflow_destination_turns WHERE key=? OR session_id=?").all(key, declaration.sessionId) as { key: string; session_id: string; turn_id: string }[];
    if (mappings.length > 1 || mappings.some(row => row.key !== key || row.session_id !== declaration.sessionId) || mappings.length && (!declared || !intents.length)) throw new Error("WorkSessionsInputFenceBindingConflict");
    const mapped = mappings[0];
    const turns = db.prepare("SELECT id,session_id FROM session_turns WHERE session_id=?").all(declaration.sessionId) as { id: string; session_id: string }[];
    if (turns.some(row => !mapped || row.id !== mapped.turn_id) || mapped && !turns.some(row => row.id === mapped.turn_id)) throw new Error("WorkSessionsInputFenceBindingConflict");
    // Count ALL historical fences, including not_started/ceased and fences with
    // no handle. A missing live handle is never a never-started proof.
    const fences = mapped
      ? db.prepare("SELECT session_id,turn_id FROM session_workflow_settlements WHERE session_id=? OR turn_id=?").all(declaration.sessionId, mapped.turn_id) as { session_id: string; turn_id: string }[]
      : db.prepare("SELECT session_id,turn_id FROM session_workflow_settlements WHERE session_id=?").all(declaration.sessionId) as { session_id: string; turn_id: string }[];
    if (fences.some(row => !mapped || row.session_id !== declaration.sessionId || row.turn_id !== mapped.turn_id)) throw new Error("WorkSessionsInputFenceBindingConflict");
    const old = db.prepare("SELECT * FROM session_workflow_work_input_fences WHERE key=? OR session_id=?").all(key, declaration.sessionId) as ProofRow[];
    if (old.length > 1) throw new Error("WorkSessionsInputFenceProofConflict");
    let neverStarted = fences.length === 0;
    if (old[0]) {
      const row = old[0], proof = proofSchema.parse(JSON.parse(row.proof_json));
      if (row.key !== key || row.binding_key !== declaration.bindingKey || row.session_id !== declaration.sessionId || row.declaration_hash !== declarationHash
        || row.never_started !== Number(proof.neverStarted) || boundFingerprint(proof) !== row.proof_hash
        || proof.intentHash !== expectedRequestHash || proof.key !== key || proof.bindingKey !== declaration.bindingKey || proof.sessionId !== declaration.sessionId || proof.declarationHash !== declarationHash
        || proof.neverStarted && fences.length > 0) throw new Error("WorkSessionsInputFenceProofConflict");
      neverStarted = proof.neverStarted; // A historical false proof never upgrades from missing rows.
    }
    db.prepare("INSERT OR IGNORE INTO session_workflow_destination_cancellations(key,cancelled_at) VALUES(?,?)").run(key, new Date().toISOString());
    if (!old[0]) {
      const proof = proofSchema.parse({ version: 1, key, bindingKey: declaration.bindingKey, sessionId: declaration.sessionId,
        declarationHash, intentHash: expectedRequestHash, neverStarted, recordedAt: Date.now() });
      db.prepare(`INSERT INTO session_workflow_work_input_fences(key,binding_key,session_id,declaration_hash,never_started,proof_hash,proof_json)
        VALUES(?,?,?,?,?,?,?)`).run(key, declaration.bindingKey, declaration.sessionId, declarationHash, Number(neverStarted), boundFingerprint(proof), JSON.stringify(proof));
    }
    if (mapped) {
      // Cancellation excludes every subsequent native claim/prepare under this
      // very writer lock. Persist positive exclusion for each actual segment
      // that has NEVER acquired a settlement, including an accepted successor.
      const unclaimed = db.prepare(`SELECT s.id FROM session_run_segments s
        WHERE s.turn_id=? AND NOT EXISTS (SELECT 1 FROM session_workflow_settlements f WHERE f.segment_id=s.id)`)
        .all(mapped.turn_id) as { id: string }[];
      for (const segment of unclaimed) {
        const prior = db.prepare("SELECT * FROM session_workflow_work_segment_exclusions WHERE segment_id=?").get(segment.id) as SegmentProofRow | undefined;
        if (prior) {
          if (!segmentProofMatches(prior, declaration, key, mapped.turn_id, segment.id, expectedRequestHash)) throw new Error("WorkSessionsSegmentExclusionConflict");
          continue;
        }
        const proof = segmentProofSchema.parse({ version: 1, neverClaimed: true, key, bindingKey: declaration.bindingKey,
          sessionId: declaration.sessionId, turnId: mapped.turn_id, segmentId: segment.id, declarationHash, intentHash: expectedRequestHash, recordedAt: Date.now() });
        db.prepare(`INSERT INTO session_workflow_work_segment_exclusions(segment_id,key,binding_key,session_id,turn_id,declaration_hash,intent_hash,proof_hash,proof_json)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(segment.id, key, declaration.bindingKey, declaration.sessionId, mapped.turn_id, declarationHash, expectedRequestHash, boundFingerprint(proof), JSON.stringify(proof));
      }
    }
    return { neverStarted };
  }).immediate();
}
