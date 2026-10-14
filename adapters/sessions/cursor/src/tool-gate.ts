import { stableNodePath } from "@barry-rocks/sdk/services";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MCP server and tool denials are checked where the hook names both.
 * preToolUse permits granted native tools and defers MCP server checks to
 * beforeMCPExecution. Unknown/malformed inputs deny; successful calls emit
 * the schema's explicit allow. See docs/decisions/0030-cursor-hook-schema.md.
 */
export function writeCursorToolGate(directory: string, servers: readonly string[], deniedTools: readonly string[] = [], allowedNativeTools: readonly string[] = []): { command: string; timeout: number; failClosed: true } {
  const script = join(directory, "barry-tool-gate.cjs");
  writeFileSync(script, `const servers = new Set(${JSON.stringify(servers)});
const denied = new Set(${JSON.stringify(deniedTools)});
const native = new Set(${JSON.stringify(allowedNativeTools)});
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let allowed = false;
  try {
    const input = JSON.parse(data);
    const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
    const server = typeof input.mcp_server_name === 'string' ? input.mcp_server_name : '';
    if (input.hook_event_name === 'preToolUse') allowed = tool.startsWith('MCP:') && tool.length > 4 || native.has(tool) && !denied.has(tool) && (tool !== 'Write' || native.has('Edit') && !denied.has('Edit'));
    if (input.hook_event_name === 'beforeMCPExecution') {
      allowed = servers.has(server) && tool !== '' && !denied.has('mcp__' + server + '__' + tool) && !denied.has('mcp__' + server.replace(/-/g, '_') + '__' + tool);
    }
  } catch {}
  console.log(JSON.stringify(allowed ? { permission: 'allow' } : { permission: 'deny', agent_message: 'Barry tools only' }));
});
`, { mode: 0o600 });
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  // https://cursor.com/docs/hooks: failClosed blocks crashes, timeouts, nonzero exits and empty output.
  // Keep the documented key; pinned live failure injection is still required.
  return { command: `${quote(stableNodePath())} ${quote(script)}`, timeout: 10, failClosed: true };
}
