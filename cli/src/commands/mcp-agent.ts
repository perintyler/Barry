import { spawn } from "child_process";
import { CliError } from "../lib/cli-error.js";
import { resolveCursorBin } from "../lib/cursor-bin.js";

/** Cursor MCP server names in mcp.json (alphanumeric, hyphens, underscores). */
const MCP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

async function runCursorMcp(action: "enable" | "disable", name: string): Promise<number> {
  const bin = await resolveCursorBin();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["agent", "mcp", action, name], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function mcpEnableCommand(name: string): Promise<void> {
  if (!MCP_NAME_RE.test(name)) {
    throw new CliError("Invalid MCP server name. Use letters, digits, hyphens, and underscores only.", 1);
  }
  const code = await runCursorMcp("enable", name);
  if (code !== 0) throw new CliError("", code);
}

export async function mcpDisableCommand(name: string): Promise<void> {
  if (!MCP_NAME_RE.test(name)) {
    throw new CliError("Invalid MCP server name. Use letters, digits, hyphens, and underscores only.", 1);
  }
  const code = await runCursorMcp("disable", name);
  if (code !== 0) throw new CliError("", code);
}
