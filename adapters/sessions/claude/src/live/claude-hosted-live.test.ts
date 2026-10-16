import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionConfig, SessionEvent } from "@barry-rocks/sdk/sessions";
import { startProbe, type Probe } from "./probe.js";
import { startClaudeLive } from "../hosted/start.js";
import { CLAUDE_LIVE } from "../modes.js";

const recording = vi.hoisted(() => ({ phase: "", lines: [] as Array<{ phase: string; dir: "in" | "out"; m: unknown }> }));
vi.mock("../anthropic-compatible/event-mapping.js", async original => {
  const mapping = await original<typeof import("../anthropic-compatible/event-mapping.js")>();
  return { ...mapping, createSDKMessageMapper() {
    const map = mapping.createSDKMessageMapper();
    return (message: Parameters<typeof map>[0]) => {
      recording.lines.push({ phase: recording.phase, dir: "out", m: message });
      return map(message);
    };
  }, processSDKMessage(message: Parameters<typeof mapping.processSDKMessage>[0]) {
    recording.lines.push({ phase: recording.phase, dir: "out", m: message });
    return mapping.processSDKMessage(message);
  } };
});
const sessions: Session[] = [];
let probe: Probe | undefined;
afterEach(async () => { await Promise.allSettled(sessions.splice(0).map(s => s.close())); await probe?.close(); probe = undefined; });
async function until(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 15000, interval: 20 });
}
async function turn(session: Session, prompt: string, phase: string): Promise<SessionEvent[]> {
  recording.phase = phase;
  recording.lines.push({ phase, dir: "in", m: { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: session.harnessSessionId ?? "" } });
  await session.deliver(prompt);
  return collect(session);
}
async function collect(session: Session) {
  const events: SessionEvent[] = [];
  for await (const event of session.events()) { events.push(event); if (event.type === "done") break; }
  expect(events.filter(e => e.type === "done")).toHaveLength(1);
  return events;
}

it.skipIf(process.env.BARRY_CLAUDE_LIVE !== "1")("proves hosted on the bundled build with a local endpoint", async () => {
  recording.lines.length = 0;
  const key = "hosted-probe-key-never-record";
  const home = mkdtempSync(join(tmpdir(), "barry-claude-hosted-"));
  probe = await startProbe(key);
  const { default: adapter } = await import("../adapter.js");
  const config: SessionConfig = { sessionId: "hosted-probe", cwd: home, env: { HOME: home, PATH: process.env.PATH, ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: probe.url }, model: "anthropic/haiku", mcpServers: { probe: { type: "http", url: probe.url + "/mcp" } }, decide: async request => ({ allow: false, reason: "review refused" , ...(request.tool.endsWith("__probe_tool") ? { allow: true } : {}) }) };
  const start = async (c = config) => { const s = await adapter.modes.hosted!.start(c, async () => { throw Error("no engine needed"); }); sessions.push(s); return s; };
  const warnings: string[] = [];
  const warning = (w: Error & { code?: string }) => { if (w.code) warnings.push(w.code); };
  process.on("warning", warning);
  try {
    const session = await start();
    const first = await turn(session, "Remember FIRST_MARKER", "memory-first");
    expect(first.filter(e => e.type === "init")).toHaveLength(1);
    expect(session.harnessVersion).toBe("2.1.282");
    const id = session.harnessSessionId;
    const before = probe.modelRequests.length;
    await turn(session, "Recall the earlier turn", "memory-second");
    expect(probe.modelRequests.slice(before).some(r => r.body.includes("FIRST_MARKER"))).toBe(true);
    await turn(session, "CALL_TOOL:probe_tool", "allowed");
    expect(probe.mcpCalls.some(c => c.method === "tools/call" && c.tool === "probe_tool")).toBe(true);
    const refused = await turn(session, "CALL_TOOL:probe_refused", "refused");
    expect(probe.mcpCalls.some(c => c.method === "tools/call" && c.tool === "probe_refused")).toBe(false);
    expect(JSON.stringify(refused)).toContain("review refused");
    expect(probe.modelRequests.at(-1)?.body).toContain("review refused");
    const sentinel = join(home, "sentinel");
    const native = await turn(session, `FORCE_BASH:${sentinel}`, "native");
    expect(native.find(e => e.type === "tool_use")).toMatchObject({ tool: "Bash" });
    expect(native.find(e => e.type === "tool_result")).toMatchObject({ error: true, result: expect.stringContaining("Bash is disabled") });
    expect(existsSync(sentinel)).toBe(false);

    recording.phase = "steer";
    const count = probe.modelRequests.length;
    await session.deliver("HOLD CALL_TOOL:probe_tool");
    await until(() => probe!.modelRequests.length > count);
    expect(await session.deliver("STEER_MARKER", { ifActive: "steer" })).toMatchObject({ status: "steered" });
    probe.release();
    await collect(session);
    expect(probe.modelRequests.at(-1)?.body).toContain("STEER_MARKER");

    recording.phase = "interrupt";
    const held = probe.modelRequests.length;
    await session.deliver("HOLD interrupted");
    await until(() => probe!.modelRequests.length > held);
    await session.interrupt();
    await collect(session);
    probe.release();
    await turn(session, "Continue after interrupt", "after-interrupt");
    expect(session.harnessSessionId).toBe(id);
    await session.close();
    const adopted = await adapter.modes.hosted!.adopt!(id!, config);
    sessions.push(adopted);
    await turn(adopted, "Recall FIRST_MARKER", "adopt");
    expect(adopted.harnessSessionId).toBe(id);
    expect(probe.modelRequests.at(-1)?.body).toContain("FIRST_MARKER");
    const perTurn = await start({ ...config, sessionId: "ephemeral", ephemeral: true });
    await turn(perTurn, "CALL_TOOL:probe_refused", "per-turn");
    expect(probe.mcpCalls.some(c => c.method === "tools/call" && c.tool === "probe_refused")).toBe(false);
    const window = startClaudeLive({ ...config, sessionId: "window", decide: () => new Promise(() => {}) }, { guarantees: CLAUDE_LIVE.guarantees, rulingWindow: 3 });
    sessions.push(window);
    expect(JSON.stringify(await turn(window, "CALL_TOOL:probe_refused", "window"))).toContain("no ruling within 3s");
    expect(probe.mcpCalls.some(c => c.method === "tools/call" && c.tool === "probe_refused")).toBe(false);
    expect(probe.modelRequests.every(r => r.credential === "expected")).toBe(true);
    expect(warnings).not.toContain("CLAUDE_SDK_CAN_USE_TOOL_SHADOWED");
    for (const phase of new Set(recording.lines.map(l => l.phase).filter(Boolean))) expect(recording.lines.filter(l => l.phase === phase && (l.m as { type?: string }).type === "result"), `phase ${phase}`).toHaveLength(1);
    if (process.env.BARRY_CLAUDE_RECORD === "1") {
      const raw = recording.lines.map(line => JSON.stringify(line)).join("\n") + "\n";
      expect(raw).not.toContain(key);
      const dir = new URL("../hosted/__fixtures__/", import.meta.url);
      mkdirSync(dir, { recursive: true });
      writeFileSync(new URL("sdk-2.1.282.jsonl", dir), raw);
    }
  } finally { process.off("warning", warning); }
}, 90000);

// BARRY_CLAUDE_LIVE=1: bundled Claude, scratch HOME and local Anthropic probe.
it.skipIf(process.env.BARRY_CLAUDE_LIVE !== "1")("native grants allow file reads and refuse shell", async () => {
  const home = mkdtempSync(join(tmpdir(), "barry-claude-native-"));
  probe = await startProbe("native-probe-key");
  const { default: adapter } = await import("../adapter.js");
  const read = join(home, "fixture.txt"), sentinel = join(home, "sentinel");
  writeFileSync(read, "GRANTED_NATIVE_READ");
  const session = await adapter.modes.hosted!.start({ sessionId: "native-probe", cwd: home, env: { HOME: home, PATH: process.env.PATH, ANTHROPIC_API_KEY: "native-probe-key", ANTHROPIC_BASE_URL: probe.url }, model: "anthropic/haiku", mcpServers: {}, allowedNativeTools: ["Read", "Glob", "Grep"] }, async () => { throw Error("no engine"); });
  sessions.push(session);
  expect(JSON.stringify(await turn(session, `FORCE_READ:${read}`, "native-read"))).toContain("GRANTED_NATIVE_READ");
  expect(probe.modelRequests.at(-1)?.tools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep"]));
  expect(probe.modelRequests.at(-1)?.tools).not.toContain("Bash");
  expect(JSON.stringify(await turn(session, `FORCE_BASH:${sentinel}`, "native-shell"))).toContain("Bash is disabled");
  expect(existsSync(sentinel)).toBe(false);
}, 90000);
