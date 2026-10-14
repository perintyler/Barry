import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionConfig, SessionEvent } from "@barry-rocks/sdk/sessions";
import { startProbe, type Probe } from "./probe.js";
import { resolveAntigravityBin } from "../bin.js";
const sessions: Session[] = [];
const gateInjection = vi.hoisted(() => ({ failure: undefined as "missing" | "error" | "timeout" | undefined }));
vi.mock("../workspace.js", async original => {
  const workspace = await original<typeof import("../workspace.js")>();
  return { ...workspace, writeAntigravityWorkspace(...args: Parameters<typeof workspace.writeAntigravityWorkspace>) {
    const plan = workspace.writeAntigravityWorkspace(...args);
    const gate = join(plan.workspaceDir, ".agents", "tool_gate.cjs");
    if (gateInjection.failure === "missing") rmSync(gate);
    else if (gateInjection.failure) writeFileSync(gate, gateInjection.failure === "error" ? "throw new Error('synthetic gate failure');" : "setInterval(() => {}, 1000);", { mode: 0o600 });
    return plan;
  } };
});
let probe: Probe | undefined;
afterEach(async () => { gateInjection.failure = undefined; await Promise.allSettled(sessions.splice(0).map(s => s.close())); await probe?.close(); probe = undefined; vi.unstubAllEnvs(); });
async function collect(session: Session) {
  const events: SessionEvent[] = [];
  for await (const event of session.events()) { events.push(event); if (event.type === "done") break; }
  expect(events.filter(e => e.type === "done")).toHaveLength(1);
  return events;
}
it.skipIf(process.env.BARRY_ANTIGRAVITY_LIVE !== "1").each(["valid", "missing", "error", "timeout"] as const)("native hook failure %s preserves the gate", async failure => {
  const root = mkdtempSync(join(tmpdir(), "agy-hook-failure-"));
  vi.stubEnv("BARRY_HOME", join(root, "barry"));
  probe = await startProbe("local-probe");
  gateInjection.failure = failure === "valid" ? undefined : failure;
  const { default: adapter } = await import("../adapter.js");
  const sentinel = join(root, "sentinel");
  const session = await adapter.modes.hosted!.start({ sessionId: `hook-${failure}`, cwd: root, env: { GEMINI_API_KEY: "local-probe", GOOGLE_GEMINI_BASE_URL: probe.url, PATH: process.env.PATH }, model: "google/gemini-3.8-flash-high", mcpServers: {}, allowedNativeTools: ["run_command"] }, async () => { throw Error("no engine"); });
  sessions.push(session);
  await session.deliver(`FORCE_SHELL:${sentinel}`);
  const events = await collect(session);
  expect(probe.modelRequests.length).toBeGreaterThan(0);
  expect(existsSync(sentinel), JSON.stringify(events)).toBe(failure === "valid");
}, 45_000);
it.skipIf(process.env.BARRY_ANTIGRAVITY_LIVE !== "1")("proves hosted tools, credentials, output, interrupt and process resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-agy-hosted-"));
  const binary = resolveAntigravityBin();
  const phaseFile = join(root, "phase"), recording = join(root, "recording.jsonl");
  const wrapper = join(root, "agy");
  writeFileSync(phaseFile, "first");
  writeFileSync(wrapper, `#!${process.execPath}
const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const {readFileSync,appendFileSync} = require('node:fs');
const child = spawn(${JSON.stringify(binary)},process.argv.slice(2),{env:process.env,stdio:['pipe','pipe','inherit']});
const record=(dir,line)=>{try{appendFileSync(${JSON.stringify(recording)},JSON.stringify({phase:readFileSync(${JSON.stringify(phaseFile)},'utf8'),dir,m:JSON.parse(line)})+'\\n');}catch{}};
createInterface({input:process.stdin}).on('line',line=>{record('in',line);child.stdin.write(line+'\\n');});
createInterface({input:child.stdout}).on('line',line=>{record('out',line);process.stdout.write(line+'\\n');});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',(code)=>process.exit(code??0));
`, { mode: 0o755 });
  vi.stubEnv("ANTIGRAVITY_BIN", wrapper);
  vi.stubEnv("BARRY_HOME", join(root, "barry"));
  vi.stubEnv("GEMINI_API_KEY", "ambient-key-must-not-reach-probe");
  const key = "identity-key-never-record";
  probe = await startProbe(key);
  const { default: adapter } = await import("../adapter.js");
  const config: SessionConfig = { sessionId: "hosted-live", cwd: root, env: { GEMINI_API_KEY: key, GOOGLE_GEMINI_BASE_URL: probe.url, PATH: `${homedir()}/.local/bin:${process.env.PATH}` }, model: "google/gemini-3.8-flash-high", mcpServers: { probe: { type: "http", url: probe.url + "/mcp" } } };
  const start = async (resume?: string) => { const s = await adapter.modes.hosted!.start({ ...config, ...(resume ? { resume: { harnessSessionId: resume } } : {}) }, async () => { throw Error("no engine"); }); sessions.push(s); return s; };
  const turn = async (session: Session, phase: string, prompt: string, structured = false) => {
    writeFileSync(phaseFile, phase);
    await session.deliver(prompt, structured ? { outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } : undefined);
    return collect(session);
  };
  try {
    const session = await start();
    const first = await turn(session, "first", "Remember FIRST_AGY_MARKER");
    expect(first.some(e => e.type === "init")).toBe(true);
    const id = session.harnessSessionId;
    expect(id).toBeTruthy();
    await turn(session, "allowed", "CALL_TOOL:probe_tool");
    expect(probe.mcpCalls.some(c => c.method === "tools/call" && c.tool === "probe_tool" && c.sessionId === config.sessionId)).toBe(true);
    const sentinel = join(root, "sentinel");
    const refused = await turn(session, "refused", `FORCE_SHELL:${sentinel}`);
    expect(JSON.stringify(refused)).toContain("Barry tools only");
    expect((await import("node:fs")).existsSync(sentinel)).toBe(false);
    await session.close();
    const resumed = await start(id!);
    const count = probe.modelRequests.length;
    await turn(resumed, "resume", "Recall the earlier turn");
    expect(resumed.harnessSessionId).toBe(id);
    expect(probe.modelRequests.slice(count).some(r => r.body.includes("FIRST_AGY_MARKER"))).toBe(true);
    const output = await turn(resumed, "structured", "STRUCTURED", true);
    expect(output.find(e => e.type === "result")).toMatchObject({ structured: { ok: true } });
    writeFileSync(phaseFile, "interrupt");
    await resumed.deliver("HOLD");
    await vi.waitFor(() => expect(probe!.holding()).toBe(true), { timeout: 15000 });
    await resumed.interrupt();
    await collect(resumed);
    probe.release();
    expect(probe.modelRequests.every(r => r.credential === "expected")).toBe(true);
    if (process.env.BARRY_ANTIGRAVITY_RECORD === "1") {
      const raw = readFileSync(recording, "utf8");
      expect(raw).not.toContain(key);
      const dir = new URL("../hosted/__fixtures__/", import.meta.url);
      mkdirSync(dir, { recursive: true });
      writeFileSync(new URL("stream-json-1.3.1.jsonl", dir), raw);
    }
  } catch (error) {
    writeFileSync(join(root, "requests.json"), JSON.stringify(probe.modelRequests.map(r => r.parsedBody), null, 2));
    console.error(`Hosted probe artifacts: ${root}`);
    throw error;
  }
}, 90000);

// BARRY_ANTIGRAVITY_LIVE=1: local Gemini probe and installed agy; no vendor key.
it.skipIf(process.env.BARRY_ANTIGRAVITY_LIVE !== "1")("records native hook names before granting categories", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-agy-native-names-"));
  vi.stubEnv("BARRY_HOME", join(root, "barry"));
  probe = await startProbe("local-probe");
  const { default: adapter } = await import("../adapter.js");
  const { antigravityHome } = await import("../workspace.js");
  const session = await adapter.modes.hosted!.start({ sessionId: "native-names", cwd: root, env: { GEMINI_API_KEY: "local-probe", GOOGLE_GEMINI_BASE_URL: probe.url, PATH: `${homedir()}/.local/bin:${process.env.PATH}` }, model: "google/gemini-3.8-flash-high", mcpServers: {} }, async () => { throw Error("no engine"); });
  sessions.push(session);
  await session.deliver("Warm the process");
  await collect(session);
  const script = join(antigravityHome(session.id), ".agents", "tool_gate.cjs");
  const recording = join(root, "native-hooks.jsonl");
  writeFileSync(script, readFileSync(script, "utf8").replace("let allowed = false;", `require('node:fs').appendFileSync(${JSON.stringify(recording)}, data + '\\n');\n  let allowed = false;`));
  const calls = [
    { name: "run_command", args: { CommandLine: `touch ${join(root, "sentinel")}`, Cwd: root, WaitMsBeforeAsync: 0 } },
    { name: "view_file", args: { AbsolutePath: join(root, "fixture.txt"), StartLine: 1, EndLine: 10 } },
    { name: "write_to_file", args: { TargetFile: join(root, "write-sentinel"), CodeContent: "sentinel", Overwrite: true, Description: "Local native probe" } },
    { name: "read_url_content", args: { Url: probe.url + "/fixture" } },
  ];
  writeFileSync(join(root, "fixture.txt"), "native-read-fixture");
  for (const call of calls) {
    await session.deliver(`FORCE_NATIVE:${Buffer.from(JSON.stringify({ ...call, args: { ...call.args, toolSummary: "Native probe", toolAction: "Probing native" } })).toString("base64")}`);
    expect(JSON.stringify(await collect(session))).toContain("Barry tools only");
  }
  const names = readFileSync(recording, "utf8").trim().split("\n").map(line => JSON.parse(line).toolCall.name);
  expect(names).toEqual(calls.map(call => call.name));
  expect((await import("node:fs")).existsSync(join(root, "sentinel"))).toBe(false);
  expect((await import("node:fs")).existsSync(join(root, "write-sentinel"))).toBe(false);
  console.info(`Antigravity hook names: ${names.join(", ")}`);
}, 90000);

// BARRY_ANTIGRAVITY_LIVE=1: installed agy with a local Gemini endpoint, no secrets.
it.skipIf(process.env.BARRY_ANTIGRAVITY_LIVE !== "1")("native grants allow file reads and refuse shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-agy-native-"));
  vi.stubEnv("BARRY_HOME", join(root, "barry"));
  probe = await startProbe("local-probe");
  const { default: adapter } = await import("../adapter.js");
  const { NATIVE } = await import("../native-tools.js");
  const read = join(root, "fixture.txt"), sentinel = join(root, "sentinel");
  writeFileSync(read, "GRANTED_NATIVE_READ");
  const session = await adapter.modes.hosted!.start({ sessionId: "native-grants", cwd: root, env: { GEMINI_API_KEY: "local-probe", GOOGLE_GEMINI_BASE_URL: probe.url, PATH: `${homedir()}/.local/bin:${process.env.PATH}` }, model: "google/gemini-3.8-flash-high", mcpServers: {}, allowedNativeTools: NATIVE.grantable.filter(name => ["view_file", "grep_search", "find_by_name", "list_dir"].includes(name)) }, async () => { throw Error("no engine"); });
  sessions.push(session);
  const call = { name: "view_file", args: { AbsolutePath: read, StartLine: 1, EndLine: 10, toolSummary: "Read fixture", toolAction: "Reading fixture" } };
  await session.deliver(`FORCE_NATIVE:${Buffer.from(JSON.stringify(call)).toString("base64")}`);
  expect((await collect(session)).find(event => event.type === "tool_result")).toMatchObject({ error: false });
  expect(probe.modelRequests.at(-1)?.body).toContain("GRANTED_NATIVE_READ");
  await session.deliver(`FORCE_SHELL:${sentinel}`);
  expect(JSON.stringify(await collect(session))).toContain("Barry tools only");
  expect((await import("node:fs")).existsSync(sentinel)).toBe(false);
}, 90000);
