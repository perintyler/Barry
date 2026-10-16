import { stableNodePath, writePrivateFile } from "@barry-rocks/sdk/services";
import { allowedNative, disallowedTools } from "./native-tools.js";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { join } from "node:path";

/** Disable paths outside the local PreToolUse gate, including exec transports. */
export function toolGateConfig(config: Pick<SessionConfig, "allowedNativeTools" | "deniedTools"> = {}) {
  const allowed = new Set(allowedNative(config));
  return {
    web_search: allowed.has("web_search") ? "live" : "disabled",
    "features.hooks": true,
    "features.shell_tool": allowed.has("exec_command") && allowed.has("write_stdin"),
    "features.code_mode": false,
    "features.code_mode_only": false,
    "features.code_mode_host": false,
    "features.js_repl": false,
    "features.image_generation": false,
    "features.imagegenext": false,
    "features.browser_use": false,
    "features.computer_use": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "features.plugins": false,
    "features.apps": false,
    "features.connectors": false,
    "features.non_prefixed_mcp_tool_names": false,
    "features.tool_search": false,
    "features.tool_search_always_defer_mcp_tools": false,
    "features.goals": false,
    "features.default_mode_request_user_input": false,
    "tools.experimental_request_user_input.enabled": false,
    "features.search_tool": false,
    "features.view_image": allowed.has("view_image"),
    "tools.update_plan.enabled": false,
    ...Object.fromEntries(["standalone_web_search", "request_permissions_tool", "sleep_tool", "memories", "agent_message_board", "send_message_to_user_async", "tool_suggest", "skill_search"].map(feature => [`features.${feature}`, false])),
  };
}

export const NATIVE_HOOK_NAMES: Readonly<Record<string, string>> = { exec_command: "Bash", apply_patch: "apply_patch", view_image: "view_image" };

export function writeCodexToolGate(home: string, servers: readonly string[], deniedTools: readonly string[] = [], allowedNativeTools: readonly string[] = [], commandHome: string = home): void {
  deniedTools = disallowedTools({ deniedTools: [...deniedTools], allowedNativeTools: [...allowedNativeTools] });
  const allowed = allowedNative({ deniedTools: [...deniedTools], allowedNativeTools: [...allowedNativeTools] }).map(tool => NATIVE_HOOK_NAMES[tool] ?? tool);
  const script = join(home, "barry-tool-gate.cjs");
  const prefixes = servers.map(server => `mcp__${server.replace(/-/g, "_")}__`);
  writePrivateFile(script, `const prefixes = ${JSON.stringify(prefixes)};
const denied = new Set(${JSON.stringify(deniedTools.map(tool => NATIVE_HOOK_NAMES[tool] ?? tool))});
const native = new Set(${JSON.stringify(allowed)});
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let allowed = false;
  try {
    const input = JSON.parse(data);
    allowed = typeof input.tool_name === 'string' && (native.has(input.tool_name) || prefixes.some(prefix => input.tool_name.startsWith(prefix) && input.tool_name.length > prefix.length)) && !denied.has(input.tool_name);
  } catch {}
  // Codex reads an explicit allow as a failed hook, so an allowed call says nothing.
  if (!allowed) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Barry tools only' } }));
});
`);
  // Finish before Codex's own deadline: vendor hook failures otherwise permit the call.
  writePrivateFile(join(home, "barry-tool-gate-launcher.cjs"), `const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const deny = () => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Barry tool gate unavailable' } }));
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  const result = spawnSync(process.execPath, [join(__dirname, 'barry-tool-gate.cjs')], { input: data, encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) { deny(); return; }
  if (!result.stdout.trim()) return;
  try {
    const output = JSON.parse(result.stdout);
    if (output.hookSpecificOutput?.hookEventName !== 'PreToolUse' || output.hookSpecificOutput.permissionDecision !== 'deny') { deny(); return; }
    console.log(JSON.stringify(output));
  } catch { deny(); }
});
`);
  writePrivateFile(join(home, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: codexToolGateCommand(commandHome), timeout: 10 }] }] } }));
}

export function codexToolGateCommand(home: string): string {
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  return `${quote(stableNodePath())} ${quote(join(home, "barry-tool-gate-launcher.cjs"))}`;
}
