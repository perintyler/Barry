import { stableNodePath } from "@barry-rocks/sdk/services";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LaunchInbox } from "@barry-rocks/sdk/adapters/harnesses";

export interface InstrumentedHooksPlan {
  inbox: LaunchInbox;
  setup(workspaceDir: string, deniedTools?: string[], servers?: string[], allowedNativeTools?: readonly string[]): void;
  close(): void;
  drainUnclaimed(): Array<{ content: string; from?: string }>;
}

function mergeHooksFile(hooksDir: string, newHooks: Record<string, unknown>): void {
  mkdirSync(hooksDir, { recursive: true });
  const file = join(hooksDir, "hooks.json");
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      existing = {};
    }
  }
  const merged = { ...existing, ...newHooks };
  writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const command = (script: string) => `${quote(stableNodePath())} ${quote(script)}`;

/** Setup tool gating script and PreToolUse hook. */
export function setupGating(workspaceDir: string, deniedTools: string[] = [], servers: string[] = [], structured = false, allowedNativeTools: readonly string[] = []): void {
  const hooksDir = join(workspaceDir, ".agents");
  mkdirSync(hooksDir, { recursive: true });
  const gatingScript = join(hooksDir, "tool_gate.cjs");
  writeFileSync(
    gatingScript,
    `const fs = require('node:fs');
const path = require('node:path');
const cliDir = ${JSON.stringify(join(workspaceDir, ".gemini", "antigravity-cli"))};
const servers = new Set(${JSON.stringify(servers)});
const denied = new Set(${JSON.stringify(deniedTools.filter((tool) => tool !== "call_mcp_tool"))});
const native = new Set(${JSON.stringify(allowedNativeTools)});
// agy spills large MCP results and tool schemas to its private home. Reading
// those is part of consuming MCP, even when native filesystem tools are denied.
function runtimeRead(call) {
  if (!call || call.name !== 'view_file' || typeof call.args?.AbsolutePath !== 'string') return false;
  const file = call.args.AbsolutePath;
  if (!path.isAbsolute(file)) return false;
  try {
    const root = fs.realpathSync(cliDir);
    const resolved = path.resolve(file);
    // Reject symlinks, including symlinked parents, to keep the exception local.
    if (fs.realpathSync(resolved) !== resolved || !fs.statSync(resolved).isFile()) return false;
    const parts = path.relative(root, resolved).split(path.sep);
    if (parts.length === 6 && parts[0] === 'brain' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1]) &&
        parts[2] === '.system_generated' && parts[3] === 'steps' &&
        /^[0-9]+$/.test(parts[4]) && parts[5] === 'output.txt') return true;
    if (parts.length === 3 && parts[0] === 'mcp' && servers.has(parts[1]) && parts[2].endsWith('.json')) {
      const tool = parts[2].slice(0, -5);
      return tool.length > 0 && !denied.has('mcp__' + parts[1].replace(/-/g, '_') + '__' + tool);
    }
  } catch {}
  return false;
}
let data = '';
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  let allowed = false;
  try {
    const parsed = JSON.parse(data);
    const call = parsed.toolCall;
    // Under --json-schema, finish only formats the requested response.
    allowed = ${structured} && call && call.name === 'finish' || call && native.has(call.name) && !denied.has(call.name) || runtimeRead(call);
    if (call && call.name === 'call_mcp_tool' && call.args) {
      const server = call.args.ServerName;
      const tool = call.args.ToolName;
      const qualified = 'mcp__' + String(server).replace(/-/g, '_') + '__' + tool;
      allowed = servers.has(server) && typeof tool === 'string' && tool.length > 0 && !denied.has(qualified);
    }
  } catch {}
  console.log(JSON.stringify({ decision: allowed ? 'allow' : 'deny', reason: 'Barry tools only' }));
});
`,
    { mode: 0o600 },
  );

  const hooks = {
    "barry-gating": {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: command(gatingScript), timeout: 5 }] }],
    },
  };
  mergeHooksFile(hooksDir, hooks);
}

/** Set up tracking relay hooks for Barry session events.
 * Rationale: docs/decisions/0034-adapter-build-capture-and-relay-rationale.md.
 */
export function setupTrackingHooks(workspaceDir: string, relayCommand: string): void {
  const hooksDir = join(workspaceDir, ".agents");
  const tracking = { type: "command", command: relayCommand, timeout: 5 };
  const hooks = {
    "barry-tracking": {
      PreInvocation: [tracking],
      PostInvocation: [tracking],
      Stop: [tracking],
    },
  };
  mergeHooksFile(hooksDir, hooks);
}

/** One atomic file per message avoids racing the vendor hook's queue drain. */
export function createInstrumentedHooks(): InstrumentedHooksPlan {
  const pending: Array<{ content: string; from?: string }> = [];
  let inboxDir: string | undefined;
  let closed = false;
  let sequence = 0;

  const persist = (message: { content: string; from?: string }): boolean => {
    if (closed) return false;
    if (!inboxDir) {
      pending.push(message);
      return true;
    }
    if (!existsSync(inboxDir)) return false;
    try {
      const name = `${Date.now()}-${String(sequence++).padStart(8, "0")}-${randomUUID()}.json`;
      const file = join(inboxDir, name);
      writeFileSync(file + ".tmp", JSON.stringify(message), { mode: 0o600 });
      renameSync(file + ".tmp", file);
      return true;
    } catch {
      return false;
    }
  };

  const inbox: LaunchInbox = {
    guarantee: "turn-end",
    deliver: async (message) => persist(message),
  };

  return {
    inbox,
    close() {
      closed = true;
    },
    drainUnclaimed(): Array<{ content: string; from?: string }> {
      const unclaimed: Array<{ content: string; from?: string }> = [...pending.splice(0)];
      if (inboxDir && existsSync(inboxDir)) {
        try {
          for (const name of readdirSync(inboxDir).filter((n) => n.endsWith(".json")).sort()) {
            const file = join(inboxDir, name);
            try {
              const data = JSON.parse(readFileSync(file, "utf8"));
              unclaimed.push(data);
              unlinkSync(file);
            } catch {
              // Ignore unparseable or unreadable inbox messages
            }
          }
        } catch {
          // Ignore directory reading errors
        }
      }
      return unclaimed;
    },
    setup(workspaceDir, deniedTools = [], servers = [], allowedNativeTools = []) {
      const hooksDir = join(workspaceDir, ".agents");
      mkdirSync(hooksDir, { recursive: true });
      inboxDir = join(hooksDir, "barry-inbox");
      mkdirSync(inboxDir, { mode: 0o700, recursive: true });
      for (const name of readdirSync(inboxDir)) rmSync(join(inboxDir, name), { recursive: true, force: true });
      for (const message of pending.splice(0)) persist(message);

      const inboxScript = join(hooksDir, "inbox_check.cjs");
      writeFileSync(
        inboxScript,
        `const fs = require('node:fs');
const path = require('node:path');
const directory = ${JSON.stringify(inboxDir)};
const injectSteps = [];
try {
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
      const file = path.join(directory, name);
      const claimed = file + '.claimed';
      try { fs.renameSync(file, claimed); } catch { continue; }
      try {
        const message = JSON.parse(fs.readFileSync(claimed, 'utf8'));
        injectSteps.push({ userMessage: message.from ? '[' + message.from + ']: ' + message.content : message.content });
        fs.unlinkSync(claimed);
      } catch {
        try { fs.unlinkSync(claimed); } catch {}
      }
    }
  }
} catch {}
console.log(JSON.stringify(injectSteps.length ? { injectSteps } : {}));
`,
        { mode: 0o600 },
      );

      const hooks = {
        "barry-inbox": { PreInvocation: [{ type: "command", command: command(inboxScript), timeout: 5 }] },
      };
      mergeHooksFile(hooksDir, hooks);
      setupGating(workspaceDir, deniedTools, servers, false, allowedNativeTools);
    },
  };
}
