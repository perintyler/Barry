/** Actual hosted adapters and stores, isolated from installed Barry and vendor history. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import type { Session, SessionConfig, SessionEvent } from "@barry-rocks/sdk/sessions";

const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const name = value("--adapter");
if (!name || !["claude", "codex", "cursor", "opencode", "pi", "antigravity"].includes(name)) throw new Error("Use --adapter claude|codex|cursor|opencode|pi|antigravity, --model vendor/model and --env /path/to/test-credentials.json");
const preflight = args.includes("--preflight");
const offline = args.includes("--offline");
if (offline && !["codex", "claude", "antigravity"].includes(name)) throw new Error("The scripted endpoint supports codex, claude and antigravity");
const negative = args.includes("--negative-control");
if (negative && (!offline || name !== "codex")) throw new Error("Negative control is allowed only with the local Codex endpoint");
const envFile = value("--env");
if (!preflight && !offline && !envFile) throw new Error("Live turns require explicit test credentials via --env; ambient logins are never used");
const declared: Record<string, string> = envFile ? JSON.parse(readFileSync(resolve(envFile), "utf8")) : { ANTHROPIC_API_KEY: "qa-no-model-requests", OPENAI_API_KEY: "qa-no-model-requests", GEMINI_API_KEY: "qa-no-model-requests" };
if (Object.entries(declared).some(([key, val]) => typeof val !== "string" || /^(HOME|BARRY_|XDG_|CODEX_HOME|PI_CODING_AGENT_DIR)/.test(key))) throw new Error("Credential file must contain only explicit vendor credential variables");
const root = mkdtempSync("/private/tmp/barry-qa-");
writeFileSync(join(root, ".barry-adapter-qa"), "1");
const home = join(root, "home"), cwd = join(root, "repo");
mkdirSync(home); mkdirSync(cwd);
// Remove credential, login and service routing variables before loading any Barry/vendor module.
for (const key of Object.keys(process.env)) if (/(KEY|TOKEN|SECRET|BARRY|OPENCODE|CLAUDE|CODEX|CURSOR|PI_CODING_AGENT|GEMINI|GOOGLE|ANTIGRAVITY|XDG_)/.test(key)) delete process.env[key];
Object.assign(process.env, { HOME: home, BARRY_HOME: join(root, "barry"), BARRY_SESSIONS_DB: join(root, "sessions.db"), BARRY_IDENTITIES_DB: join(root, "identities.db"), XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), XDG_RUNTIME_DIR: join(home, "run") });
const local = offline ? name === "codex" ? await (await import("./model.js")).scriptedModel(root) : await (await import("./model.js")).scriptedVendorModel(root, name as "claude" | "antigravity") : undefined;
if (local && name === "claude") declared.ANTHROPIC_BASE_URL = local.url;
if (local && name === "antigravity") declared.GOOGLE_GEMINI_BASE_URL = local.url;
const sdkPackage = realpathSync(new URL(`../${name}/node_modules/@barry-rocks/sdk`, import.meta.url));
console.log(`QA SDK package: ${sdkPackage}`);
const { default: adapter } = await import(`../${name}/src/adapter.js`);
const { ownedEngines } = await import("../../../bags/sessions/src/engines/index.js");
const { createSession, getSessionMessages, getProviderSessionsBySession } = await import("../../../bags/sessions/src/client/index.js");
const { trackSession } = await import("../../../cli/src/tracked-session.js");
const engines = ownedEngines({ baseDir: join(root, "engines") });

const active = new Set<Session>();
const observed: unknown[] = [];
const marker = randomUUID();
const model = value("--model") as SessionConfig["model"];
if (model && !model.includes("/")) throw new Error("Use --model vendor/model");
const probe = join(dirname(fileURLToPath(import.meta.url)), "probe.cjs");
const ledger = () => existsSync(join(root, "ledger.jsonl")) ? readFileSync(join(root, "ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const config = (id: string, vendorId?: string): SessionConfig => ({ sessionId: id, cwd, env: { ...declared, BARRY_QA_ROOT: root }, ...(model ? { model } : {}), mcpServers: { probe: { command: process.execPath, args: [probe], env: { BARRY_QA_ROOT: root } } }, ...(vendorId ? { resume: { harnessSessionId: vendorId } } : {}) });
const start = async (id: string, vendorId?: string) => {
  if (!adapter.modes.hosted) throw new Error("No hosted mode");
  const raw = await adapter.modes.hosted.start(config(id, vendorId), (spec: import("@barry-rocks/sdk/adapters/harnesses").EngineSpec) => engines.start(local && name === "codex" ? {
    ...spec, command: address => {
      const command = spec.command(address);
      if (negative) writeFileSync(join(command.env.CODEX_HOME, "barry-tool-gate.cjs"), `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}))`);
      return { ...command, args: [...command.args, "-c", 'model_provider="barry_qa"', "-c", `model_providers.barry_qa={name="Barry QA",base_url="${local.url}",wire_api="responses"}`] };
    },
  } : spec));
  active.add(raw);
  return trackSession(raw, adapter.id, model);
};
const turn = async (session: Session, prompt: string) => {
  const events: SessionEvent[] = [];
  const timer = setTimeout(() => { engines.stopAll(); process.stderr.write(`QA timed out; artifacts: ${root}\n`); process.exit(1); }, Number(value("--timeout-ms") ?? 120000));
  try {
    await session.deliver(prompt);
    for await (const event of session.events()) {
      events.push(event); observed.push({ sessionId: session.id, event });
      if (event.type === "done") break;
    }
    assert(events.some(event => event.type === "done"), "Missing terminal done");
    assert(!events.some(event => event.type === "error" || event.type === "result" && event.error), "Adapter returned an error; inspect events");
    return events;
  } finally { clearTimeout(timer); }
};
const evidence: Record<string, unknown> = { runId: marker, adapter: adapter.id, model, os: process.platform, node: process.version, entryPoint: "direct hosted SDK + Barry recorder", checks: {}, limitations: ["Does not certify CLI/API/actions, trait authorization or native enforcement", "Model refusal without an attempted call is inconclusive", "Preflight never certifies a conversation or a matrix cell"] };
try {
  evidence.commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const id = "target-" + marker;
  await createSession({ id, agent_token: null, metadata: { provider: adapter.id, working_directory: cwd } });
  const session = await start(id);
  evidence.version = session.harnessVersion;
  if (preflight) {
    if (name === "pi") {
      // pi's hosted session internals, which only this preflight inspects.
      const pi = [...active].find(item => item.id === id) as (Session & { init(): Promise<void>; sessionInstance: { getActiveToolNames(): string[] } }) | undefined;
      if (!pi) throw new Error("preflight lost its pi session");
      await pi.init();
      const deadline = Date.now() + 10000;
      while (!pi.sessionInstance.getActiveToolNames().some(tool => tool.endsWith("echo")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      const names = pi.sessionInstance.getActiveToolNames(); evidence.exposedTools = names;
      assert(names.every(tool => tool.startsWith("mcp__probe__")), "A native or ambient tool is exposed");
      assert(names.some(tool => tool.endsWith("echo")), "Probe MCP failed to load");
    }
    evidence.preflight = "passed";
  } else {
    await turn(session, `Call the probe echo tool with marker ${marker}. Remember the marker for this conversation.`);
    await turn(session, "Call the probe echo tool again with the remembered marker. Do not invent a marker.");
    const original = session.harnessSessionId;
    assert(original, "No vendor conversation ID");
    const links = await getProviderSessionsBySession(id);
    assert(links.some(link => link.provider_session_id === original), "Provider link missing");
    const calls = ledger().filter(call => call.sessionId === id && call.tool === "echo" && call.args.marker === marker);
    assert(calls.length >= 2, "Two authorized calls did not reach the recording MCP server");
    const stored = await getSessionMessages(id);
    assert(stored.messages.filter(message => message.role === "user").length === 2, "User messages missing or duplicated");
    assert(stored.messages.some(message => message.type === "tool_start" && message.toolUseId && message.result), "Tool input/result correlation missing");
    assert(stored.messages.every(message => typeof message.sequence === "number"), "Sequence is not a number");
    assert.equal(new Set(stored.messages.map(message => message.sequence)).size, stored.messages.length, "Duplicate message sequences");
    evidence.checks = { V02: "passed for this entry point" };
    await session.close();
    const decoyId = "decoy-" + marker;
    await createSession({ id: decoyId, agent_token: null, metadata: { provider: adapter.id } });
    const decoy = await start(decoyId); await turn(decoy, "Reply DECOY. Do not call any tools."); await decoy.close();
    const resumed = await start(id, original);
    await turn(resumed, "Call the probe echo tool with the marker you remember from before this process restarted.");
    assert.equal(resumed.harnessSessionId, original, "Resume changed conversations");
    assert(ledger().filter(call => call.sessionId === id && call.tool === "echo" && call.args.marker === marker).length >= 3, "Old conversation marker not recalled after a newer decoy");
    Object.assign(evidence.checks as object, { V03: "passed for this entry point", V04: "older target passed; missing-ID check still required" });
    if (local) {
      const blocked = [];
      for (const tool of name === "claude" ? ["Bash"] : name === "antigravity" ? ["run_command"] : ["apply_patch", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
        const before = local.requests.length;
        await turn(resumed, `NATIVE_PROBE:${tool}`);
        assert(!existsSync(join(cwd, "native-sentinel.txt")), "Native patch executed despite the guard");
        const outputs = name === "codex" ? local.requests.slice(before).flatMap(request => request.input as Array<Record<string, unknown>>).filter(item => item.type === "function_call_output" || item.type === "custom_tool_call_output") : local.requests.slice(before).map(request => name === "claude" ? request.messages : request.contents);
        assert(outputs.some(item => name === "claude" ? /Bash is disabled for this session/.test(JSON.stringify(item)) : JSON.stringify(item).includes("Barry tools only")), `No runtime hook denial for ${tool}`);
        blocked.push(tool);
      }
      evidence.nativeBlocking = { blocked, scope: "These actual forced calls only; other modes and conditional capabilities remain unverified" };
    }
    await resumed.close();
    if (name === "codex") {
      const missingId = "missing-" + randomUUID();
      await createSession({ id: missingId, agent_token: null, metadata: { provider: adapter.id } });
      const missing = await start(missingId, randomUUID());
      await missing.deliver("Do not create a replacement conversation.");
      let refusal = "";
      for await (const event of missing.events()) {
        observed.push({ sessionId: missingId, event });
        assert(event.type !== "init", "Missing target created a replacement conversation");
        if (event.type === "error") refusal = event.error;
        if (event.type === "done") break;
      }
      assert.match(refusal, /not found|no rollout|does not exist|could not find/i, "Missing vendor target must fail clearly");
      await missing.close();
      Object.assign(evidence.checks as object, { V04: "older target and missing-target refusal passed for this entry point" });
    }
  }
} catch (error) { evidence.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await Promise.allSettled([...active].map(session => session.close())); engines.stopAll(); await local?.close();
  writeFileSync(join(root, "events.json"), JSON.stringify(observed, null, 2));
  writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ artifacts: root, evidence }, null, 2));
}
