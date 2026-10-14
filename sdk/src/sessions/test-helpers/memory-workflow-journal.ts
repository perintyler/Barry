import type { WorkflowSessionBindingRecord, WorkflowSessionJournalStore, WorkflowSessionTurnRecord, WorkflowSessionTurnStatus } from "../workflow-turns.js";
import { encodeEffectJson } from "../../tools/effect-json.js";

/** Deterministic journal fixture. Production implementations belong to the Sessions store. */
export class MemoryWorkflowSessionJournal implements WorkflowSessionJournalStore {
  private readonly bindings = new Map<string, WorkflowSessionBindingRecord>();
  private readonly turns = new Map<string, WorkflowSessionTurnRecord>();
  async getBinding(key: string) { const row = this.bindings.get(key); return row && { ...row }; }
  async getBindingBySession(sessionId: string) { const row = [...this.bindings.values()].find(item => item.sessionId === sessionId); return row && { ...row }; }
  async admitBinding(record: WorkflowSessionBindingRecord) {
    if (this.bindings.has(record.key) || [...this.bindings.values()].some(row => row.sessionId === record.sessionId)) return false;
    this.bindings.set(record.key, { ...record }); return true;
  }
  async readyBinding(key: string) { const row = this.bindings.get(key); if (!row) throw new Error("unknown workflow session binding"); row.state = "ready"; }
  async getTurn(key: string) { const row = this.turns.get(key); return row && { ...row }; }
  async admitTurn(record: WorkflowSessionTurnRecord) {
    if (this.turns.has(record.key) || [...this.turns.values()].some(row => row.sessionId === record.sessionId && ["admitted", "active", "uncertain", "interrupting"].includes(row.state))) return false;
    this.turns.set(record.key, { ...record }); return true;
  }
  async updateTurn(key: string, state: WorkflowSessionTurnStatus, result?: string): Promise<WorkflowSessionTurnStatus> {
    if ((state === "complete") !== (result !== undefined)) throw new Error("workflow turn results are valid only for completion");
    if (result !== undefined) {
      let parsed: unknown;
      try { parsed = JSON.parse(result); } catch { throw new Error("workflow turn result must be bounded JSON"); }
      if (encodeEffectJson(parsed) !== result) throw new Error("workflow turn result must be canonical bounded JSON");
    }
    const row = this.turns.get(key); if (!row) throw new Error("unknown workflow session turn");
    const allowed: Record<WorkflowSessionTurnStatus, WorkflowSessionTurnStatus[]> = {
      admitted: ["active", "uncertain", "interrupting", "interrupted", "complete"],
      active: ["uncertain", "interrupting", "interrupted", "complete"],
      uncertain: ["interrupting", "interrupted", "complete"],
      interrupting: ["interrupted", "uncertain", "complete"], interrupted: ["complete"], complete: [],
    };
    if (allowed[row.state].includes(state)) { row.state = state; if (result !== undefined) row.result = result; }
    return row.state;
  }
}
