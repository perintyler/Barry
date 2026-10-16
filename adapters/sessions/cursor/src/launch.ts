/**
 * Cursor's guest launch: the human drives the `cursor-agent` TUI in the
 * session's own home, on the identity's key.
 *
 * Cursor takes almost nothing on the command line: MCP servers, permissions
 * and Barry's gate all travel through a generated project directory, and the
 * conversation id is reserved by running the binary once before the launch.
 *
 * A one-shot is refused, and the launcher runs it hosted instead.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Guarantees, LaunchPlan } from "@barry-rocks/sdk/adapters/harnesses";

import { parseModelRef } from "@barry-rocks/sdk/ids";
import { NotSupportedInMode, type SessionConfig } from "@barry-rocks/sdk/sessions";
import { cursorEnv, keepUserHome, PINNED_LAUNCH, prepareCursorHome, requireCursorKey, resolveCursorAgent } from "./runtime.js";
import { agentsMdFor, writeCursorSessionWorkspace, type CursorHooksJson } from "./workspace.js";

const CHAT_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface CursorLaunchExtras {
  /** Reserves a chat id. Injectable so a test needs no cursor install. */
  reserveChat?: (command: string, env: Record<string, string>, cwd: string) => Promise<string | undefined>;
  /** Project hooks beyond Barry's gate, such as instrumented's relay. */
  hooks?: CursorHooksJson;
}

export async function planCursorLaunch(config: SessionConfig, guarantees: Guarantees, extras: CursorLaunchExtras = {}): Promise<LaunchPlan> {
  requireCursorKey(config.env);
  if (oneShotPrompt(config)) throw new NotSupportedInMode("prompt", "guest");

  const warnings: string[] = [];
  const home = prepareCursorHome(config.sessionId);
  const env = cursorEnv(config, home);
  const agent = resolveCursorAgent(undefined, config.env);

  const { workspaceDir, unenforceableDenials } = writeCursorSessionWorkspace(
    { mcpServers: keepUserHome(config.mcpServers) },
    {
      agentsMd: agentsMdFor(config),
      allowedNativeTools: config.allowedNativeTools, deniedTools: config.deniedTools,
      ...(extras.hooks ? { hooks: extras.hooks } : {}),
    },
  );
  // A denial cursor has no permission kind for cannot be enforced in the
  // workspace; say so rather than letting the launch surface read as if the
  // denial held (ADP-18). A partial guard that reads as total is worse than a
  // missing one.
  if (unenforceableDenials.length) {
    warnings.push(`cursor cannot enforce these denials in-session, so they are not applied: ${unenforceableDenials.join(", ")}`);
  }

  // A conversation hosted mode ran is not a chat the TUI can open: the two
  // are kept apart. A new one is reserved, and said so.
  const recorded = config.resume?.harnessSessionId;
  let chat = recorded && chatExists(home, recorded) ? recorded : undefined;
  if (recorded && !chat) {
    warnings.push("The recorded conversation ran hosted, which cursor's TUI cannot open; this launch starts a new chat, and Barry's transcript keeps the earlier turns.");
  }
  chat ??= await (extras.reserveChat ?? reserveChat)(agent.command, env, workspaceDir);
  if (!chat) warnings.push("Cursor gave no chat id, so `barry resume` cannot reopen this conversation.");

  const args = [
    ...PINNED_LAUNCH,
    "--force",
    "--approve-mcps",
    "--trust",
    "--workspace", workspaceDir,
    "--add-dir", config.cwd,
    ...(config.pluginDirs ?? []).flatMap((dir) => ["--plugin-dir", dir]),
    ...(config.projectRoots ?? []).flatMap((root) => ["--add-dir", root]),
    ...(chat ? ["--resume", chat] : []),
    ...(config.model ? ["--model", parseModelRef(config.model)?.model ?? config.model] : []),
  ];

  return {
    command: agent.command,
    args,
    env,
    // The workspace, not the repo: cursor reads `.cursor/` from the git root
    // of the directory it starts in, and ignores `--workspace` doing it.
    cwd: workspaceDir,
    tmpDirs: [workspaceDir],
    ...(chat ? { harnessSessionId: chat } : {}),
    guarantees: { ...guarantees },
    warnings,
  };
}

/** Whether a chat is in the session's home, where the TUI keeps its chats. */
export function chatExists(home: string, chatId: string): boolean {
  const chats = join(home, ".cursor", "chats");
  if (!existsSync(chats)) return false;
  return readdirSync(chats).some((workspace) => existsSync(join(chats, workspace, chatId)));
}

/** `create-chat` prints the id and then does not exit, so the id is read and the process stopped. */
function reserveChat(command: string, env: Record<string, string>, cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, [...PINNED_LAUNCH, "create-chat"], { env, cwd, stdio: ["ignore", "pipe", "ignore"] });
    let printed = "";
    const done = (id: string | undefined) => {
      clearTimeout(timer);
      child.kill();
      resolve(id);
    };
    const timer = setTimeout(() => done(undefined), 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      printed += chunk.toString();
      const id = CHAT_ID.exec(printed)?.[0];
      if (id) done(id);
    });
    child.once("error", () => done(undefined));
    // `close`, not `exit`: exit can come before the last of stdout is read.
    child.once("close", () => done(CHAT_ID.exec(printed)?.[0]));
  });
}

/** `barry start -p`: a one-shot, which this mode refuses. */
function oneShotPrompt(config: SessionConfig): string | undefined {
  const options = config.options;
  if (options === null || typeof options !== "object" || !("prompt" in options)) return undefined;
  return typeof options.prompt === "string" && options.prompt ? options.prompt : undefined;
}
