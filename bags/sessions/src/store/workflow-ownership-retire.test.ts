/** Executor-owned retirement of settled workflow destinations (P8.2a, G7, RE1). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { workflowSessionId } from "@barry-rocks/sdk/internal/sessions";
import { getSessionsSqlite, closeSessionsDb } from "./sessions-db.js";
import { workflowTurnsStore } from "./workflow-turns.js";
import { WorkflowDestinations } from "./workflow-destinations.js";
import { ExecutionConflict } from "./turn-continuations.js";
import {
  deleteSessionSqlite,
  deleteSessionsByIdentitySqlite,
  retireWorkflowSessionSqlite,
  retireWorkflowSessionsByIdentitySqlite,
} from "./sessions-sqlite-writes.js";
import * as ownership from "./workflow-ownership.js";
import * as writes from "./sessions-sqlite-writes.js";

let directory: string;
beforeEach(() => {
  closeSessionsDb();
  directory = mkdtempSync(join(tmpdir(), "workflow-ownership-retire-"));
  vi.stubEnv("BARRY_SESSIONS_DB", join(directory, "sessions.db"));
});
afterEach(() => {
  closeSessionsDb();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
const evidence = {
  identity: "retired-identity",
  traits: [],
  bound: null,
  harness: "pi",
  tools: {},
};
const scope: ApprovedBounds = { ...evidence, fingerprint: boundFingerprint(evidence) };
const ownerProcess = {
  pid: 12345,
  pid_started_at: 123456,
  hostname: "synthetic-host",
  bootIdentity: "synthetic-boot",
};

/** One destination whose only segment ran to known physical cessation and a completed turn. */
async function settledDestination(suffix = "") {
  const db = getSessionsSqlite(),
    destination = new WorkflowDestinations(db, ownerProcess);
  const bindingKey = `retire/run${suffix}`,
    sessionId = workflowSessionId(bindingKey, scope.identity!),
    key = `retire/turn${suffix}`,
    owner = "settled-owner",
    input = { text: "settled input" };
  await workflowTurnsStore.admitBinding({
    key: bindingKey,
    requestHash: boundFingerprint({ key: bindingKey, identity: scope.identity, scope }),
    sessionId,
    identity: scope.identity!,
    scopeHash: scope.fingerprint,
    state: "admitted",
  });
  destination.bind({
    bindingKey,
    sessionId,
    identity: scope.identity!,
    identityId: 42,
    actorId: 1,
    scope,
    selection: {
      harness: "pi",
      model: "fixture/model",
      endpoint: "fixture-endpoint",
      cwd: directory,
      maxTurns: 1,
      deadline: 2_000_000_000_000,
    },
  });
  await workflowTurnsStore.readyBinding(bindingKey);
  await workflowTurnsStore.admitTurn({
    key,
    sessionId,
    requestHash: boundFingerprint({ sessionId, input, scope }),
    state: "active",
    result: null,
  });
  const admitted = destination.admit({ key, sessionId, input, scope }),
    turnId = admitted.turn.id,
    segmentId = admitted.turn.runId;
  expect(destination.claim(sessionId, turnId, segmentId, owner)).toBe(true);
  destination.preparing(segmentId, owner);
  destination.handle(segmentId, owner, {
    kind: "process",
    pid: 23456,
    pgid: 23456,
    pidStartedAt: 234567,
    hostname: ownerProcess.hostname,
    bootIdentity: ownerProcess.bootIdentity,
    sessionId,
    turnId,
    segmentId,
  });
  destination.input(segmentId, owner);
  destination.closing(segmentId, owner);
  destination.ceased(segmentId, owner);
  destination
    .turns(bindingKey)
    .finish(sessionId, turnId, owner, { state: "completed", result: { settled: true } });
  return { db, destination, bindingKey, key, sessionId, turnId, segmentId };
}

it("reaches a fully settled destination: ceased segment, completed turn, nothing unsettled", async () => {
  const f = await settledDestination();
  expect(f.destination.unsettled()).toEqual([]);
  expect(f.destination.settlements(f.turnId)).toMatchObject([
    { segmentId: f.segmentId, phase: "ceased", ceasedAt: expect.any(String) },
  ]);
  expect(f.db.prepare("SELECT state FROM session_turns WHERE id=?").get(f.turnId)).toEqual({
    state: "completed",
  });
  expect(
    f.db
      .prepare("SELECT count(*) AS n FROM session_workflow_destinations WHERE session_id=?")
      .get(f.sessionId),
  ).toEqual({ n: 1 });
});

it("refuses unretired interactive deletion, retires a settled workflow-owned session preserving dedup keys, and then deletes cleanly", async () => {
  const f = await settledDestination(),
    before = f.db.prepare("SELECT * FROM sessions WHERE id=?").get(f.sessionId);
  expect(() => deleteSessionSqlite(f.sessionId)).toThrow(ExecutionConflict);
  expect(() => deleteSessionSqlite(f.sessionId)).toThrow(
    "This session belongs to its workflow executor",
  );
  expect(f.db.prepare("SELECT * FROM sessions WHERE id=?").get(f.sessionId)).toEqual(before);

  const retired = retireWorkflowSessionSqlite(f.sessionId);
  expect(retired).toEqual({ retired: true, sessionId: f.sessionId, bindingKey: f.bindingKey });
  // Idempotent on second call.
  expect(retireWorkflowSessionSqlite(f.sessionId)).toEqual({
    retired: false,
    sessionId: f.sessionId,
    bindingKey: null,
  });
  expect(f.db.prepare("SELECT state, active FROM sessions WHERE id=?").get(f.sessionId)).toEqual({
    state: "closed",
    active: 0,
  });
  // Durable dedup keys remain intact in session_workflow_bindings and session_workflow_turns.
  expect(
    f.db.prepare("SELECT key, state FROM session_workflow_bindings WHERE key=?").get(f.bindingKey),
  ).toEqual({ key: f.bindingKey, state: "ready" });
  expect(
    f.db.prepare("SELECT key, state FROM session_workflow_turns WHERE key=?").get(f.key),
  ).toEqual({ key: f.key, state: "complete" });

  deleteSessionSqlite(f.sessionId);
  expect(f.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(f.sessionId)).toBeUndefined();
  expect(f.db.prepare("SELECT 1 FROM session_turns WHERE id=?").get(f.turnId)).toBeUndefined();
  expect(
    f.db.prepare("SELECT key FROM session_workflow_bindings WHERE key=?").get(f.bindingKey),
  ).toEqual({ key: f.bindingKey });
  expect(
    f.db.prepare("SELECT key, state FROM session_workflow_turns WHERE key=?").get(f.key),
  ).toEqual({ key: f.key, state: "complete" });
});

it("refuses identity retirement when any segment is unsettled (naming the segment), and succeeds once settled so identity deletion completes", async () => {
  const f = await settledDestination("-1");
  f.db.prepare("INSERT INTO sessions(id,identity_id) VALUES('ordinary-sibling',42)").run();
  expect(() => deleteSessionsByIdentitySqlite(42)).toThrow(ExecutionConflict);
  expect(() => deleteSessionsByIdentitySqlite(42)).toThrow(
    "This session belongs to its workflow executor",
  );

  // Add a second workflow destination for identity 42 with an unsettled physical segment.
  const bindingKey2 = "retire/run-2",
    sessionId2 = workflowSessionId(bindingKey2, scope.identity!),
    key2 = "retire/turn-2",
    input2 = { text: "unsettled" };
  await workflowTurnsStore.admitBinding({
    key: bindingKey2,
    requestHash: boundFingerprint({ key: bindingKey2, identity: scope.identity, scope }),
    sessionId: sessionId2,
    identity: scope.identity!,
    scopeHash: scope.fingerprint,
    state: "admitted",
  });
  f.destination.bind({
    bindingKey: bindingKey2,
    sessionId: sessionId2,
    identity: scope.identity!,
    identityId: 42,
    actorId: 1,
    scope,
    selection: {
      harness: "pi",
      model: "fixture/model",
      endpoint: "fixture-endpoint",
      cwd: directory,
      maxTurns: 1,
      deadline: 2_000_000_000_000,
    },
  });
  await workflowTurnsStore.readyBinding(bindingKey2);
  await workflowTurnsStore.admitTurn({
    key: key2,
    sessionId: sessionId2,
    requestHash: boundFingerprint({ sessionId: sessionId2, input: input2, scope }),
    state: "active",
    result: null,
  });
  const admitted2 = f.destination.admit({ key: key2, sessionId: sessionId2, input: input2, scope }),
    turnId2 = admitted2.turn.id,
    segmentId2 = admitted2.turn.runId;
  expect(f.destination.claim(sessionId2, turnId2, segmentId2, "live-owner")).toBe(true);
  f.destination.preparing(segmentId2, "live-owner");

  expect(() => retireWorkflowSessionsByIdentitySqlite(42)).toThrow(ExecutionConflict);
  expect(() => retireWorkflowSessionsByIdentitySqlite(42)).toThrow(segmentId2);
  // Atomic refusal: neither workflow destination was retired.
  expect(
    f.db
      .prepare("SELECT count(*) AS n FROM session_workflow_destinations WHERE identity_id=42")
      .get(),
  ).toEqual({ n: 2 });

  // Settle the second destination via handle -> closing -> ceased and finish turn.
  f.destination.handle(segmentId2, "live-owner", {
    kind: "process",
    pid: 23457,
    pgid: 23457,
    pidStartedAt: 234568,
    hostname: ownerProcess.hostname,
    bootIdentity: ownerProcess.bootIdentity,
    sessionId: sessionId2,
    turnId: turnId2,
    segmentId: segmentId2,
  });
  f.destination.closing(segmentId2, "live-owner");
  f.destination.ceased(segmentId2, "live-owner");
  f.destination
    .turns(bindingKey2)
    .finish(sessionId2, turnId2, "live-owner", { state: "failed", error: "stopped" });

  const retired = retireWorkflowSessionsByIdentitySqlite(42);
  expect(retired).toHaveLength(2);
  expect(retired.every((entry) => entry.retired)).toBe(true);
  expect(deleteSessionsByIdentitySqlite(42)).toBe(3);
  expect(f.db.prepare("SELECT count(*) AS n FROM sessions WHERE identity_id=42").get()).toEqual({
    n: 0,
  });
});

it("exports explicit executor-side retirement operations from the ownership and session write modules", () => {
  expect(Object.keys(ownership).sort()).toEqual([
    "assertInteractiveSession",
    "retireWorkflowDestination",
  ]);
  expect(
    Object.keys(writes)
      .filter((name) => /retire|release|forget|purge/i.test(name))
      .sort(),
  ).toEqual(["retireWorkflowSessionSqlite", "retireWorkflowSessionsByIdentitySqlite"]);
});

it("still deletes a plain interactive session and an identity with only interactive sessions", async () => {
  const f = await settledDestination();
  f.db
    .prepare(
      "INSERT INTO sessions(id,identity_id) VALUES('interactive',43),('interactive-2',43),('single',44)",
    )
    .run();
  deleteSessionSqlite("single");
  expect(f.db.prepare("SELECT 1 FROM sessions WHERE id='single'").get()).toBeUndefined();
  expect(deleteSessionsByIdentitySqlite(43)).toBe(2);
  expect(f.db.prepare("SELECT count(*) AS n FROM sessions WHERE identity_id=43").get()).toEqual({
    n: 0,
  });
});
