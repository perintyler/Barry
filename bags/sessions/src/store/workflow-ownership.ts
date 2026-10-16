import type Database from "better-sqlite3";
import { ExecutionConflict } from "./turn-continuations.js";

export interface RetiredWorkflowDestination {
  retired: boolean;
  sessionId: string;
  bindingKey: string | null;
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** Canonical destination membership, never mutable session metadata or a supplied turn ID. */
export function assertInteractiveSession(db: Database.Database, sessionId: string): void {
  if (
    hasTable(db, "session_workflow_destinations") &&
    db.prepare("SELECT 1 FROM session_workflow_destinations WHERE session_id=?").get(sessionId)
  ) {
    throw new ExecutionConflict("This session belongs to its workflow executor");
  }
}

/**
 * Executor-owned retirement of a settled workflow destination (P8.2a / G7).
 *
 * Refuses with ExecutionConflict if any physical segment is unsettled, any
 * turn or tool call outcome remains active/uncertain, any interrupt is pending,
 * or immutable recovery receipts still pin settlement rows. Preserves durable
 * binding/turn dedup keys and immutable authority/fence/refusal tables while
 * releasing destination ownership so session/identity deletion can proceed.
 */
export function retireWorkflowDestination(
  db: Database.Database,
  sessionId: string,
): RetiredWorkflowDestination {
  return db
    .transaction((): RetiredWorkflowDestination => {
      if (!hasTable(db, "session_workflow_destinations")) {
        return { retired: false, sessionId, bindingKey: null };
      }
      const destination = db
        .prepare("SELECT binding_key FROM session_workflow_destinations WHERE session_id=?")
        .get(sessionId) as { binding_key: string } | undefined;
      if (!destination) {
        return { retired: false, sessionId, bindingKey: null };
      }

      if (hasTable(db, "session_workflow_settlements")) {
        const unsettled = db
          .prepare(
            "SELECT segment_id, phase FROM session_workflow_settlements WHERE session_id=? AND (ceased_at IS NULL OR phase NOT IN ('ceased','not_started')) ORDER BY rowid",
          )
          .all(sessionId) as { segment_id: string; phase: string }[];
        if (unsettled.length > 0) {
          throw new ExecutionConflict(
            `Cannot retire workflow session ${sessionId} with unsettled segments: ${unsettled.map((row) => `${row.segment_id} (${row.phase})`).join(", ")}`,
          );
        }
        if (hasTable(db, "session_workflow_outcome_recoveries")) {
          const pinned = db
            .prepare(
              "SELECT r.segment_id FROM session_workflow_outcome_recoveries r JOIN session_workflow_settlements s ON s.segment_id=r.segment_id WHERE s.session_id=? ORDER BY r.rowid",
            )
            .all(sessionId) as { segment_id: string }[];
          if (pinned.length > 0) {
            throw new ExecutionConflict(
              `Cannot retire workflow session ${sessionId} with immutable outcome recovery receipts: ${pinned.map((row) => row.segment_id).join(", ")}`,
            );
          }
        }
        if (hasTable(db, "session_workflow_physical_settlements")) {
          const pinned = db
            .prepare(
              "SELECT r.segment_id FROM session_workflow_physical_settlements r JOIN session_workflow_settlements s ON s.segment_id=r.segment_id WHERE s.session_id=? ORDER BY r.rowid",
            )
            .all(sessionId) as { segment_id: string }[];
          if (pinned.length > 0) {
            throw new ExecutionConflict(
              `Cannot retire workflow session ${sessionId} with immutable physical settlement receipts: ${pinned.map((row) => row.segment_id).join(", ")}`,
            );
          }
        }
      }

      if (hasTable(db, "session_turns")) {
        const activeTurns = db
          .prepare(
            "SELECT id, state, owner FROM session_turns WHERE session_id=? AND (state NOT IN ('completed','failed','cancelled') OR owner IS NOT NULL) ORDER BY rowid",
          )
          .all(sessionId) as { id: string; state: string; owner: string | null }[];
        if (activeTurns.length > 0) {
          throw new ExecutionConflict(
            `Cannot retire workflow session ${sessionId} with active turns: ${activeTurns.map((row) => `${row.id} (${row.state})`).join(", ")}`,
          );
        }
      }

      if (hasTable(db, "session_call_outcomes") && hasTable(db, "session_turns")) {
        const uncertainCalls = db
          .prepare(
            "SELECT c.turn_id, c.call_id, c.state FROM session_call_outcomes c JOIN session_turns t ON t.id=c.turn_id WHERE t.session_id=? AND c.state IN ('executing','uncertain') ORDER BY c.rowid",
          )
          .all(sessionId) as { turn_id: string; call_id: string; state: string }[];
        if (uncertainCalls.length > 0) {
          throw new ExecutionConflict(
            `Cannot retire workflow session ${sessionId} with unsettled tool call outcomes: ${uncertainCalls.map((row) => `${row.call_id} (${row.state})`).join(", ")}`,
          );
        }
      }

      if (hasTable(db, "session_interrupts") && hasTable(db, "session_turns")) {
        const pendingInterrupts = db
          .prepare(
            "SELECT i.id FROM session_interrupts i JOIN session_turns t ON t.id=i.turn_id WHERE t.session_id=? AND i.status='pending' ORDER BY i.rowid",
          )
          .all(sessionId) as { id: string }[];
        if (pendingInterrupts.length > 0) {
          throw new ExecutionConflict(
            `Cannot retire workflow session ${sessionId} with pending interrupts: ${pendingInterrupts.map((row) => row.id).join(", ")}`,
          );
        }
      }

      if (hasTable(db, "session_workflow_turns")) {
        const uncertainIntents = db
          .prepare(
            "SELECT key, state FROM session_workflow_turns WHERE session_id=? AND state IN ('uncertain','interrupting') ORDER BY rowid",
          )
          .all(sessionId) as { key: string; state: string }[];
        if (uncertainIntents.length > 0) {
          throw new ExecutionConflict(
            `Cannot retire workflow session ${sessionId} with uncertain turn intents: ${uncertainIntents.map((row) => `${row.key} (${row.state})`).join(", ")}`,
          );
        }
        if (hasTable(db, "session_workflow_destination_turns")) {
          const unlaunched = db
            .prepare(
              `SELECT t.key FROM session_workflow_turns t
           WHERE t.session_id=? AND t.state IN ('admitted','active')
             AND NOT EXISTS (SELECT 1 FROM session_workflow_destination_turns d WHERE d.key=t.key)
             AND NOT EXISTS (SELECT 1 FROM session_workflow_destination_cancellations c WHERE c.key=t.key)
           ORDER BY t.rowid`,
            )
            .all(sessionId) as { key: string }[];
          if (unlaunched.length > 0) {
            throw new ExecutionConflict(
              `Cannot retire workflow session ${sessionId} with unlaunched turn intents: ${unlaunched.map((row) => row.key).join(", ")}`,
            );
          }
        }
        db.prepare(
          "UPDATE session_workflow_turns SET state='complete' WHERE session_id=? AND state IN ('admitted','active')",
        ).run(sessionId);
      }

      if (hasTable(db, "session_workflow_settlements")) {
        db.prepare("DELETE FROM session_workflow_settlements WHERE session_id=?").run(sessionId);
      }
      if (hasTable(db, "session_workflow_destination_turns")) {
        db.prepare("DELETE FROM session_workflow_destination_turns WHERE session_id=?").run(
          sessionId,
        );
      }
      db.prepare("DELETE FROM session_workflow_destinations WHERE session_id=?").run(sessionId);

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE sessions
       SET active = 0, state = 'closed',
           ended_at = COALESCE(ended_at, ?),
           status = CASE WHEN status IN ('completed','failed','cancelled') THEN status ELSE 'completed' END,
           completed_at = COALESCE(completed_at, ?),
           metadata = json_patch(COALESCE(metadata, '{}'), ?)
       WHERE id = ?`,
      ).run(now, now, JSON.stringify({ end_reason: "workflow-retired" }), sessionId);

      return { retired: true, sessionId, bindingKey: destination.binding_key };
    })
    .immediate();
}
