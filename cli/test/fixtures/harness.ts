import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EventQueue, type Session, type SessionConfig, type SessionEvent } from "@barry-rocks/sdk/sessions";
import type { Adapter, Guarantees } from "@barry-rocks/sdk/adapters/harnesses";
export const guarantees: Guarantees = { capture: "total", delivery: "wake", steer: true, interrupt: true, gating: "per-call", keepsVendorUi: false, identity: "inherent" };
export async function fixtureSession(config: SessionConfig): Promise<Session> {
  const queue = new EventQueue<SessionEvent>();
  const decision = await config.decide?.({ id: "fixture-denial", tool: "ForbiddenNative", input: {} });
  appendFileSync(join(config.cwd, "harness.jsonl"), JSON.stringify({ sessionId: config.sessionId, env: config.env,
    deniedTools: config.deniedTools, decision, systemPrompt: config.systemPrompt, mcpServers: config.mcpServers }) + "\n");
  return {
    id: config.sessionId, harnessSessionId: "fixture-" + config.sessionId, harnessVersion: "1", mode: "hosted", guarantees,
    events: () => queue,
    async deliver() { queue.push({ type: "result", result: "fixture completed" }); queue.push({ type: "done" }); return { messageId: randomUUID(), status: "started" }; },
    async interrupt() { queue.push({ type: "done" }); }, async answer() {}, status: () => "idle", async close() { queue.end(); },
  };
}
export const fixtureAdapter: Adapter = {
  id: "acceptance", label: "Disposable acceptance harness", bag: ".", tools: ["ForbiddenNative"], defaultMode: "hosted",
  capabilities: { mcpTransports: ["http"], toolDenial: "native", systemPromptFormat: "raw", skillsMount: "none", withoutKey: "unauthenticated", endpoint: "fixed" },
  requirements: { binary: { command: process.execPath, versionArgs: ["--version"], versionPattern: "(\\d+\\.\\d+\\.\\d+)", install: { fallback: "Use the test runner Node executable" }, pin: { version: process.versions.node, enforcedBy: "test runner executable" } } },
  modes: { guest: null, instrumented: null, hosted: { verifiedOn: "acceptance 1", guarantees,
    evidence: { check: "cli/test/acceptance/identity-bounds.test.ts", proves: "deterministic fixture events and captured bounds" },
    egressSandbox: false, structuredOutput: "prompted", start: fixtureSession } },
};
