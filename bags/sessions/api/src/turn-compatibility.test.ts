import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { TurnContinuations } from "@barry-rocks/sessions-bag/store/turn-continuations";
import { compatibilityMessages, subscribeCompatibilityTurns } from "./turn-compatibility.js";

describe("v1 projection of durable turn approvals", () => {
  it("replays only outstanding rulings on reconnect and streams committed completion", async () => {
    const db = new Database(":memory:"); db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('session');");
    db.exec(readFileSync(new URL("../../migrations/sessions/010_turn_continuations.sql", import.meta.url), "utf8"));
    db.exec(readFileSync(new URL("../../migrations/sessions/011_turn_owner_process.sql", import.meta.url), "utf8"));
    const store = new TurnContinuations(db, () => "2026-10-09T12:00:00Z");
    const turn = store.admit({ sessionId: "session", requestId: "initial", runId: "initial", actor: "user", content: "Work", policy: { mode: "review_required", expiresAt: "2026-10-09T12:01:00Z" } });
    store.claim("session", turn.id, "owner");
    const paused = store.pause("session", turn.id, "owner", { format: "fixture", version: 1, adapterId: "fixture", adapterVersion: "1", harnessVersion: "1", configFingerprint: "fixture", payload: {} }, [{ id: "first", tool: "Read", input: {} }, { id: "second", tool: "Write", input: {} }]);
    store.released("session", turn.id, "owner");
    store.recordRuling({ sessionId: "session", turnId: turn.id, interruptId: paused.interrupts[0].id, decision: { allow: true }, actor: "user" });
    const frames: Array<Record<string, unknown>> = [];
    const socket = { readyState: 1, send: (value: string) => { frames.push(JSON.parse(value)); } };
    const stop = subscribeCompatibilityTurns(store, "session", socket);
    try {
      const permissions = frames.filter((frame) => frame.type === "permission_request");
      expect(permissions).toHaveLength(1);
      expect(permissions[0]).toMatchObject({ requestId: paused.interrupts[1].id, tool: "Write" });
      const resumed = store.recordRuling({ sessionId: "session", turnId: turn.id, interruptId: paused.interrupts[1].id, decision: { allow: false }, actor: "user" });
      store.claim("session", turn.id, "next-owner");
      store.append("session", turn.id, { type: "partial", text: "Finished" });
      store.finish("session", turn.id, "next-owner", { state: "completed", result: "Finished" });
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === "result" && frame.status === "completed")).toBe(true));
      expect(frames.find((frame) => frame.type === "partial")).toMatchObject({ content: "Finished", metadata: { turnId: turn.id, runId: resumed.runId } });
      expect(frames.filter((frame) => frame.type === "permission_request")).toHaveLength(1);
    } finally { stop(); db.close(); }
  });

  it("computes the remaining persisted timeout without extending it", () => {
    const snapshot = { reviewPolicy: { mode: "review_required" }, interrupts: [{ id: "interrupt", status: "pending", call: { id: "call", tool: "Write", input: {} }, expiresAt: "2026-10-09T12:01:00Z" }] };
    expect(compatibilityMessages("session", { type: "segment_interrupted", snapshot }, Date.parse("2026-10-09T12:00:30Z"))).toMatchObject([{ requestId: "interrupt", timeoutMs: 30_000 }]);
    expect(compatibilityMessages("session", { type: "segment_interrupted", snapshot }, Date.parse("2026-10-09T12:02:00Z"))).toMatchObject([{ timeoutMs: 0 }]);
  });
});
