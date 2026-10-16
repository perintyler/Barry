import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWorkflowActor } from "@barry-rocks/sdk/internal/auth";
import { installationWorkflowActor } from "./workflow-actor.js";

let home: string;
let previousHome: string | undefined;
let previousKey: string | undefined;
beforeEach(() => {
  previousHome = process.env.BARRY_HOME;
  previousKey = process.env.BARRY_WORKFLOW_ACTOR_KEY;
  home = mkdtempSync(join(tmpdir(), "workflow-signer-owned-"));
  process.env.BARRY_HOME = home;
  process.env.BARRY_WORKFLOW_ACTOR_KEY = "ambient-workflow-key-longer-than-thirty-two";
  mkdirSync(join(home, "config"));
  mkdirSync(join(home, "app-support"));
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.BARRY_HOME; else process.env.BARRY_HOME = previousHome;
  if (previousKey === undefined) delete process.env.BARRY_WORKFLOW_ACTOR_KEY; else process.env.BARRY_WORKFLOW_ACTOR_KEY = previousKey;
  rmSync(home, { recursive: true, force: true });
});
function configure(key: string) {
  writeFileSync(join(home, "config", "barry.yaml"), "secrets:\n  BARRY_WORKFLOW_ACTOR_KEY: {in: .env}\n");
  writeFileSync(join(home, "app-support", "env"), `BARRY_WORKFLOW_ACTOR_KEY=${key}\n`);
}
const execution = { identity: "alice", bags: ["workflows"], bound: null, allowedToolIds: ["workflows:list"] };
it("reads only the installation binding and observes rotation without rebuilding the signer", async () => {
  const sign = installationWorkflowActor(execution);
  const first = "first-owned-workflow-key-longer-than-thirty-two";
  const rotated = "rotated-owned-workflow-key-longer-than-thirty-two";
  configure(first);
  const token = await sign("/api/v2/runs");
  expect(verifyWorkflowActor(token, first, "/api/v2/runs").principal).toBe("alice");
  expect(() => verifyWorkflowActor(token, process.env.BARRY_WORKFLOW_ACTOR_KEY!, "/api/v2/runs")).toThrow();
  configure(rotated);
  const next = await sign("/api/v2/runs");
  expect(verifyWorkflowActor(next, rotated, "/api/v2/runs").principal).toBe("alice");
  expect(() => verifyWorkflowActor(next, first, "/api/v2/runs")).toThrow();
});
it("keeps unauthored signing disabled and authored empty values strict", async () => {
  const sign = installationWorkflowActor(execution);
  await expect(sign("/api/v2/runs")).rejects.toThrow("not configured");
  configure("");
  await expect(sign("/api/v2/runs")).rejects.toThrow("absent or empty");
});
it("preserves the identity and operation ceiling after reading a valid key", async () => {
  configure("owned-workflow-key-longer-than-thirty-two");
  await expect(installationWorkflowActor({ ...execution, allowedToolIds: [] })("/api/v2/runs")).rejects.toThrow("outside the execution bound");
  await expect(installationWorkflowActor({ ...execution, identity: undefined })("/api/v2/runs")).rejects.toThrow("not configured");
});
