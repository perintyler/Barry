/**
 * The temp Cursor project a session runs in.
 *
 * Cursor merges a project's `.cursor/*` over the global config, so a throwaway
 * project is how Barry scopes MCP servers, permissions and hooks to one
 * session without writing into the user's repo. The agent runs here and
 * reaches the repo through `--add-dir`, which the generated instruction file names.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFile } from "@barry-rocks/sdk/services";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { writeCursorToolGate } from "./tool-gate.js";
import { disallowedTools } from "./native-tools.js";
import { buildCursorCliConfig } from "./permissions.js";

export interface CursorHooksJson {
  version: 1;
  hooks: Record<string, Array<{ command: string; matcher?: string; timeout?: number; loop_limit?: number | null }>>;
}

export interface CursorWorkspace {
  workspaceDir: string;
  selectedServers: string[];
  /** Denials Cursor has no permission kind for. Empty means the list is whole. */
  unenforceableDenials: string[];
}

export function writeCursorSessionWorkspace(
  mcpConfig: { mcpServers: Record<string, unknown> },
  options?: { agentsMd?: string; hooks?: CursorHooksJson; deniedTools?: string[]; allowedNativeTools?: string[] },
): CursorWorkspace {
  // At its real path: under `/var/folders` cursor keeps project state under
  // both spellings of a symlinked path, and an approval filed under one is
  // not found under the other.
  const workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "barry-cursor-")));
  const cursorDir = join(workspaceDir, ".cursor");
  mkdirSync(cursorDir, { recursive: true });
  writePrivateFile(join(cursorDir, "mcp.json"), JSON.stringify(mcpConfig, null, 2));

  // Cursor enforces this itself: a denied call returns permissionDenied and
  // never runs. It only loads when the agent's process starts inside this
  // directory.
  const { config: cliConfig, unenforceable } = buildCursorCliConfig(disallowedTools(options ?? {}));
  writePrivateFile(join(cursorDir, "cli.json"), JSON.stringify(cliConfig, null, 2));

  const gate = writeCursorToolGate(cursorDir, Object.keys(mcpConfig.mcpServers), disallowedTools(options ?? {}), options?.allowedNativeTools);
  const given = options?.hooks?.hooks ?? {};
  const hooks = {
    ...given,
    preToolUse: [gate, ...(given.preToolUse ?? [])],
    beforeMCPExecution: [gate, ...(given.beforeMCPExecution ?? [])],
  };
  writePrivateFile(join(cursorDir, "hooks.json"), JSON.stringify({ version: 1, hooks }, null, 2));

  if (options?.agentsMd?.trim()) {
    writePrivateFile(join(workspaceDir, "AGENTS.md"), options.agentsMd);
  }

  return {
    workspaceDir,
    selectedServers: Object.keys(mcpConfig.mcpServers),
    unenforceableDenials: unenforceable,
  };
}

/**
 * The session's guidance, followed by where its repo is: the agent's session
 * root is the workspace, so an unqualified command would run there.
 */
export function agentsMdFor(config: Pick<SessionConfig, "systemPrompt" | "cwd">): string {
  const guidance = config.systemPrompt?.trim() ? `${config.systemPrompt}\n\n` : "";
  return `${guidance}## Working tree\n\nThe repository for this session is \`${config.cwd}\`. Run commands and edit files there, not in this session directory.\n`;
}
