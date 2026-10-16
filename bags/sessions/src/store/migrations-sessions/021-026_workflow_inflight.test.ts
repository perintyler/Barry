import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { migrateStore } from "@barry-rocks/sdk/stores";
import MIGRATIONS from "../../generated/sessions-migrations.js";
import { WorkflowDestinations } from "../workflow-destinations.js";

const STORE = "workflow-inflight-fixture";
const evidence = { identity: "selected-identity", traits: ["narrow"], bound: null, harness: "pi", tools: {} };
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const selection = { harness: "pi", model: "fixture/model", endpoint: "fixture-endpoint", cwd: "/fixture/workspace", maxTurns: 2, deadline: 2_000_000_000_000 };
const bindingKey = "owner/run-upgrade", sessionId = workflowSessionId(bindingKey, scope.identity!);
const turnKey = "owner/turn-upgrade", input = { text: "In-flight across upgrade" };
const hash = (c: string) => c.repeat(64);
const count = (db: Database.Database, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const migrateTo = (db: Database.Database, version: number) => migrateStore(db, MIGRATIONS.slice(0, version), STORE);

// Every append-only receipt table introduced by 022..026 with the abort message its triggers raise.
const immutables: Record<number, { table: string; column: string; message: string }[]> = {
  22: [{ table: "session_workflow_outcome_recoveries", column: "outcome_hash", message: "workflow outcome recovery receipts are immutable" }],
  23: [{ table: "session_workflow_physical_settlements", column: "proof_json", message: "workflow physical settlement receipts are immutable" }],
  24: [{ table: "session_workflow_execution_authorities", column: "authority_json", message: "workflow execution authority is immutable" }],
  25: [
    { table: "session_workflow_work_input_fences", column: "proof_json", message: "work input fence is immutable" },
    { table: "session_workflow_work_segment_exclusions", column: "proof_json", message: "work segment exclusion is immutable" },
  ],
  26: [{ table: "session_workflow_preparation_refusals", column: "owner", message: "preparation refusal is immutable" }],
};

/** Write one receipt per table the given migration introduced, against the settled historical segment. */
function seedReceipts(db: Database.Database, version: number, turnId: string): void {
  const at = "2026-10-01T00:00:00.000Z";
  if (version === 22) db.prepare("INSERT INTO session_workflow_outcome_recoveries VALUES(?,?,?,?,?,?,?)").run("segment-settled", hash("a"), '{"type":"completed"}', '{"proof":1}', 3, 4, at);
  if (version === 23) db.prepare("INSERT INTO session_workflow_physical_settlements VALUES(?,?,?,?)").run("segment-settled", '{"proof":"ceased"}', 4, at);
  if (version === 24) db.prepare("INSERT INTO session_workflow_execution_authorities VALUES(?,?,?)").run(bindingKey, hash("b"), '{"version":1}');
  if (version === 25) {
    db.prepare("INSERT INTO session_workflow_work_input_fences VALUES(?,?,?,?,?,?,?)").run("fence-key", "other/binding", "other-session", hash("c"), 1, hash("d"), '{"fence":true}');
    db.prepare("INSERT INTO session_workflow_work_segment_exclusions VALUES(?,?,?,?,?,?,?,?,?)").run("segment-excluded", "excluded-key", "other/binding", "other-session", "other-turn", hash("c"), hash("e"), hash("f"), '{"excluded":true}');
  }
  if (version === 26) db.prepare("INSERT INTO session_workflow_preparation_refusals VALUES(?,?,?,?,?,?,?,?,?,?)").run("segment-refused", sessionId, turnId, "old-worker", bindingKey, hash("c"), hash("e"), hash("1"), "native-preparation-not-invoked@1", at);
}

it("steps a populated v20 Sessions history through 021..026 keeping an in-flight destination segment open, resumable and its receipts immutable", () => {
  const db = new Database(":memory:");
  try {
    expect(MIGRATIONS).toHaveLength(28);
    // v20: ordinary history plus coordinator intents that predate destination tables.
    expect(migrateTo(db, 20)).toEqual({ from: 0, to: 20 });
    db.prepare("INSERT INTO sessions(id,metadata) VALUES('ordinary','{\"source\":\"ordinary\"}')").run();
    db.prepare("INSERT INTO session_workflow_bindings(key,request_hash,session_id,identity,scope_hash,state) VALUES(?,?,?,?,?,'ready')")
      .run(bindingKey, boundFingerprint({ key: bindingKey, identity: scope.identity, scope }), sessionId, scope.identity, scope.fingerprint);
    db.prepare("INSERT INTO session_workflow_turns(key,session_id,request_hash,state,result) VALUES(?,?,?,'active',NULL)")
      .run(turnKey, sessionId, boundFingerprint({ sessionId, input, scope }));

    // v21: real store declares and admits the destination; the physical claim is written as a 021-era row
    // (no owner_process_json yet) and left in flight with a known handle.
    expect(migrateTo(db, 21)).toEqual({ from: 20, to: 21 });
    const v21 = new WorkflowDestinations(db);
    v21.bind({ bindingKey, sessionId, identity: scope.identity!, identityId: 42, actorId: 1, scope, selection });
    const { turn, created } = v21.admit({ key: turnKey, sessionId, input, scope });
    expect(created).toBe(true);
    expect(v21.turns(bindingKey).claim(sessionId, turn.id, "old-worker")).toBe(true);
    const settle = db.prepare("INSERT INTO session_workflow_settlements(segment_id,session_id,turn_id,owner,phase,handle_json,ceased_at,created_at) VALUES(?,?,?,?,?,?,?,?)");
    settle.run("segment-settled", sessionId, turn.id, "older-worker", "ceased", '{"native":"old"}', "2026-09-30T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    settle.run(turn.runId, sessionId, turn.id, "old-worker", "handled", '{"native":"in-flight"}', null, "2026-10-01T00:00:00.000Z");

    const tables = ["sessions", "session_turns", "session_run_segments", "session_workflow_bindings", "session_workflow_turns", "session_workflow_destinations", "session_workflow_destination_turns", "session_workflow_settlements"];
    const baseline = Object.fromEntries(tables.map((table) => [table, count(db, table)]));
    expect(baseline).toMatchObject({ sessions: 2, session_turns: 1, session_workflow_destinations: 1, session_workflow_destination_turns: 1, session_workflow_settlements: 2 });
    const openSettlement = { segmentId: turn.runId, sessionId, turnId: turn.id, owner: "old-worker", phase: "handled", ownerProcess: null, handle: { native: "in-flight" }, inputAt: null, closingAt: null, ceasedAt: null };
    expect(v21.unsettled()).toEqual([openSettlement]);

    const seeded: (typeof immutables)[number] = [];
    for (let version = 22; version <= MIGRATIONS.length; version += 1) {
      expect(migrateTo(db, version)).toEqual({ from: version - 1, to: version });
      expect(db.pragma("user_version", { simple: true })).toBe(version);
      seedReceipts(db, version, turn.id);
      seeded.push(...(immutables[version] ?? []));

      // Rows preserved and the in-flight segment still open/queryable through the real store.
      expect(Object.fromEntries(tables.map((table) => [table, count(db, table)]))).toEqual(baseline);
      expect(db.prepare("SELECT metadata FROM sessions WHERE id='ordinary'").get()).toEqual({ metadata: '{"source":"ordinary"}' });
      const store = new WorkflowDestinations(db);
      expect(store.unsettled()).toEqual([openSettlement]);
      expect(store.settlements(turn.id).map((s) => [s.segmentId, s.phase, s.ceasedAt === null])).toEqual([["segment-settled", "ceased", false], [turn.runId, "handled", true]]);
      expect(store.inspect(turnKey)).toEqual({ key: turnKey, sessionId, turnId: turn.id, requestId: expect.stringMatching(/^workflow-request-/), runId: turn.runId });
      expect(store.lookupSession(sessionId)).toMatchObject({ bindingKey, identityId: 42, actorId: 1, boundFingerprint: scope.fingerprint });
      // The open fence still excludes any second physical claim for this session.
      expect(store.claim(sessionId, turn.id, `${turn.runId}-duplicate`, "new-worker")).toBe(false);

      // Every receipt table introduced so far still rejects rewrite and removal.
      for (const { table, column, message } of seeded) {
        expect(count(db, table)).toBe(1);
        expect(() => db.prepare(`UPDATE ${table} SET ${column}=${column}`).run()).toThrow(message);
        expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(message);
      }
    }
    expect(seeded.map((entry) => entry.table)).toEqual(["session_workflow_outcome_recoveries", "session_workflow_physical_settlements", "session_workflow_execution_authorities", "session_workflow_work_input_fences", "session_workflow_work_segment_exclusions", "session_workflow_preparation_refusals"]);

    // Latest build resumes the pre-upgrade segment to physical cessation under its retained owner.
    const latest = new WorkflowDestinations(db);
    expect(() => latest.input(turn.runId, "new-worker")).toThrow("Physical settlement ownership mismatch");
    latest.input(turn.runId, "old-worker");
    latest.closing(turn.runId, "old-worker");
    latest.ceased(turn.runId, "old-worker");
    expect(latest.unsettled()).toEqual([]);
    expect(latest.settlements(turn.id).at(-1)).toMatchObject({ segmentId: turn.runId, phase: "ceased", ownerProcess: null, handle: { native: "in-flight" } });
    // Re-running the full catalog is a no-op on the upgraded history.
    expect(migrateStore(db, MIGRATIONS, STORE)).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
  } finally { db.close(); }
});
