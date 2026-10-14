import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { closeSessionsDb } from "./sessions-db.js";
import { workflowTurnsStore } from "./workflow-turns.js";

process.env.BARRY_SESSIONS_DB = join(mkdtempSync(join(tmpdir(), "barry-workflow-journal-")), "sessions.db");
afterAll(closeSessionsDb);

it("durably admits bindings and serializes one in-flight turn per session", async () => {
  const binding = { key: "owner/run", requestHash: "a".repeat(64), sessionId: "job-session", identity: "reviewer", scopeHash: "b".repeat(64), state: "admitted" as const };
  expect(await workflowTurnsStore.admitBinding(binding)).toBe(true);
  expect(await workflowTurnsStore.admitBinding(binding)).toBe(false);
  expect(await workflowTurnsStore.getBinding(binding.key)).toEqual(binding);
  await workflowTurnsStore.readyBinding(binding.key);
  expect(await workflowTurnsStore.getBindingBySession(binding.sessionId)).toMatchObject({ state: "ready", identity: binding.identity });

  const first = { key: "owner/turn-1", sessionId: binding.sessionId, requestHash: "c".repeat(64), state: "admitted" as const, result: null };
  expect(await workflowTurnsStore.admitTurn(first)).toBe(true);
  expect(await workflowTurnsStore.admitTurn({ ...first, key: "owner/turn-2" })).toBe(false);
  await workflowTurnsStore.updateTurn(first.key, "active");
  await expect(workflowTurnsStore.updateTurn(first.key, "active", "stale-result")).rejects.toThrow("valid only for completion");
  await expect(workflowTurnsStore.updateTurn(first.key, "complete")).rejects.toThrow("valid only for completion");
  await expect(workflowTurnsStore.updateTurn(first.key, "complete", "not-json")).rejects.toThrow("bounded JSON");
  await workflowTurnsStore.updateTurn(first.key, "complete", JSON.stringify({ answer: "done" }));
  expect(await workflowTurnsStore.getTurn(first.key)).toMatchObject({ state: "complete", result: '{"answer":"done"}' });
  expect(await workflowTurnsStore.updateTurn(first.key, "interrupting")).toBe("complete");
  expect(await workflowTurnsStore.admitTurn({ ...first, key: "owner/turn-2" })).toBe(true);
});
