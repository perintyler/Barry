/**
 * cursor hosted: one `cursor-agent acp` per session, in the session's own
 * home, on the identity's key.
 *
 * ACP rather than `--print`: it takes the session's MCP servers directly,
 * where `--print` in a fresh home never loads a project's servers, and it
 * asks Barry before every tool call, which no hook can be switched off from.
 * What it does not give is token usage, or an MCP call's output (it reports
 * `{success: true}`), so the mode declares near-total capture.
 *
 * ACP sessions and the CLI's chats are separate stores: neither resumes the
 * other's conversations. A conversation this mode cannot load starts afresh,
 * and Barry's own history leads the first message.
 */
import { rmSync } from "node:fs";
import type { Mode } from "@barry-rocks/sdk/adapters/harnesses";
import { acpHosted, type AcpToolCall, type AcpToolIdentity } from "@barry-rocks/sdk/acp";
import { parseModelRef } from "@barry-rocks/sdk/ids";
import type { Session, SessionConfig } from "@barry-rocks/sdk/sessions";
import { agentsMdFor, writeCursorSessionWorkspace } from "../workspace.js";
import { cursorEnv, keepUserHome, PINNED_LAUNCH, prepareCursorHome, requireCursorKey, resolveCursorAgent, unpinnedWarning } from "../runtime.js";

/** What a cursor session takes beyond the shared config, in `SessionConfig.options`. */
interface CursorOptions {
  /** cursor-agent's own `--sandbox`, not Barry's egress sandbox. */
  sandbox?: string;
}

/** ACP's kinds for cursor's native tools, as Barry's native-tool policy names them. */
const NATIVE_BY_KIND: Record<string, string> = {
  execute: "Shell",
  read: "Read",
  edit: "Edit",
  delete: "Edit",
  move: "Edit",
  search: "Grep",
  fetch: "WebFetch",
};

/**
 * An MCP call names its server and tool only in an update after it starts,
 * and a native call is known by its kind. Anything else stays unnamed, so
 * Barry's policy refuses it.
 */
export function identifyCursorTool(call: AcpToolCall): AcpToolIdentity | undefined {
  const input = call.rawInput as { providerIdentifier?: unknown; toolName?: unknown; args?: unknown } | null | undefined;
  if (typeof input?.providerIdentifier === "string" && typeof input.toolName === "string") {
    return { name: `mcp__${input.providerIdentifier}__${input.toolName}`, input: input.args ?? {} };
  }
  const native = call.kind === "search" && call.toolCallId?.startsWith("web_search_") ? "WebSearch" : call.kind ? NATIVE_BY_KIND[call.kind] : undefined;
  return native ? { name: native, input: call.rawInput ?? {} } : undefined;
}

export async function startCursorHosted(config: SessionConfig, mode: Mode): Promise<Session> {
  requireCursorKey(config.env);
  const home = prepareCursorHome(config.sessionId);
  // Its servers go over ACP; written here too they would load twice.
  const { workspaceDir } = writeCursorSessionWorkspace(
    { mcpServers: {} },
    { agentsMd: agentsMdFor(config), allowedNativeTools: config.allowedNativeTools, deniedTools: config.deniedTools },
  );
  const agent = resolveCursorAgent();
  const sandbox = (config.options as CursorOptions | undefined)?.sandbox;
  const hosted = acpHosted({
    ...mode,
    structuredOutput: "prompted",
    identifyTool: identifyCursorTool,
    command: () => ({
      command: agent.command,
      args: [
        ...PINNED_LAUNCH,
        ...(config.model ? ["--model", parseModelRef(config.model)?.model ?? config.model] : []),
        "--sandbox", sandbox === "enabled" ? "enabled" : "disabled",
        "--add-dir", config.cwd,
        ...(config.projectRoots ?? []).flatMap((root) => ["--add-dir", root]),
        ...(config.pluginDirs ?? []).flatMap((dir) => ["--plugin-dir", dir]),
        "acp",
      ],
      env: cursorEnv(config, home),
      cwd: workspaceDir,
    }),
  });

  // The agent's root is the workspace; the repo is an added directory.
  const inWorkspace: SessionConfig = { ...config, cwd: workspaceDir, mcpServers: keepUserHome(config.mcpServers) };
  const known = config.resume?.harnessSessionId;
  let session: Session;
  try {
    session = known
      ? await hosted.adopt!(known, inWorkspace).catch(() => hosted.start(inWorkspace, () => Promise.reject(new Error("cursor runs no engine"))))
      : await hosted.start(inWorkspace, () => Promise.reject(new Error("cursor runs no engine")));
  } catch (err) {
    rmSync(workspaceDir, { recursive: true, force: true });
    throw err;
  }
  return {
    ...session,
    warnings: [...(session.warnings ?? []), ...(agent.pinned ? [] : [unpinnedWarning()])],
    async close() {
      await session.close();
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}
