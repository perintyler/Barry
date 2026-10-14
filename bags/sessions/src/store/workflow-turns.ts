import type { WorkflowSessionBindingRecord, WorkflowSessionJournalStore, WorkflowSessionTurnRecord, WorkflowSessionTurnStatus } from "@barry-rocks/sdk/internal/sessions";
import { encodeEffectJson } from "@barry-rocks/sdk/internal/tools";
import { getSessionsSqlite } from "./sessions-db.js";

type BindingRow = { key: string; request_hash: string; session_id: string; identity: string; scope_hash: string; state: "admitted" | "ready" };
type TurnRow = { key: string; session_id: string; request_hash: string; state: WorkflowSessionTurnStatus; result: string | null };
const binding = (row: BindingRow | undefined): WorkflowSessionBindingRecord | undefined => row && ({ key: row.key, requestHash: row.request_hash, sessionId: row.session_id, identity: row.identity, scopeHash: row.scope_hash, state: row.state });
const turn = (row: TurnRow | undefined): WorkflowSessionTurnRecord | undefined => row && ({ key: row.key, sessionId: row.session_id, requestHash: row.request_hash, state: row.state, result: row.result });

/** SQLite implementation of the journal contract, reached through the sessions client. */
export const workflowTurnsStore: WorkflowSessionJournalStore = {
  async getBinding(key) { return binding(getSessionsSqlite().prepare("SELECT * FROM session_workflow_bindings WHERE key=?").get(key) as BindingRow | undefined); },
  async getBindingBySession(sessionId) { return binding(getSessionsSqlite().prepare("SELECT * FROM session_workflow_bindings WHERE session_id=?").get(sessionId) as BindingRow | undefined); },
  async admitBinding(row) {
    const result = getSessionsSqlite().prepare("INSERT OR IGNORE INTO session_workflow_bindings(key,request_hash,session_id,identity,scope_hash,state) VALUES(?,?,?,?,?,?)").run(row.key, row.requestHash, row.sessionId, row.identity, row.scopeHash, row.state);
    return result.changes === 1;
  },
  async readyBinding(key) { const result = getSessionsSqlite().prepare("UPDATE session_workflow_bindings SET state='ready' WHERE key=?").run(key); if (result.changes !== 1) throw new Error("unknown workflow session binding"); },
  async getTurn(key) { return turn(getSessionsSqlite().prepare("SELECT * FROM session_workflow_turns WHERE key=?").get(key) as TurnRow | undefined); },
  async admitTurn(row) {
    const result = getSessionsSqlite().prepare("INSERT OR IGNORE INTO session_workflow_turns(key,session_id,request_hash,state,result) VALUES(?,?,?,?,NULL)").run(row.key, row.sessionId, row.requestHash, row.state);
    return result.changes === 1;
  },
  async updateTurn(key, state, result) {
    if ((state === "complete") !== (result !== undefined)) throw new Error("workflow turn results are valid only for completion");
    if (result !== undefined) {
      let parsed: unknown;
      try { parsed = JSON.parse(result); } catch { throw new Error("workflow turn result must be bounded JSON"); }
      if (encodeEffectJson(parsed) !== result) throw new Error("workflow turn result must be canonical bounded JSON");
    }
    const db = getSessionsSqlite();
    const transition = db.transaction(() => {
      const row = db.prepare("SELECT state FROM session_workflow_turns WHERE key=?").get(key) as { state: WorkflowSessionTurnStatus } | undefined;
      if (!row) throw new Error("unknown workflow session turn");
      const allowed: Record<WorkflowSessionTurnStatus, WorkflowSessionTurnStatus[]> = {
        admitted: ["active", "uncertain", "interrupting", "interrupted", "complete"],
        active: ["uncertain", "interrupting", "interrupted", "complete"],
        uncertain: ["interrupting", "interrupted", "complete"],
        interrupting: ["interrupted", "uncertain", "complete"], interrupted: ["complete"], complete: [],
      };
      if (!allowed[row.state].includes(state)) return row.state;
      if (result === undefined) db.prepare("UPDATE session_workflow_turns SET state=? WHERE key=? AND state=?").run(state, key, row.state);
      else db.prepare("UPDATE session_workflow_turns SET state=?,result=? WHERE key=? AND state=?").run(state, result, key, row.state);
      return state;
    });
    return transition.immediate();
  },
};
