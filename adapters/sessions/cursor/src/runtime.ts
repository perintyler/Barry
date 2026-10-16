import { resolveHarnessCommand } from "@barry-rocks/sdk/adapters/harnesses";
/**
 * Where every cursor session runs: a home of its own, the selected
 * cursor-agent, and an environment holding the identity's key and nothing
 * of the user's.
 *
 * cursor-agent finds the user's login (in the keychain), config, hooks, MCP
 * servers and even claude's hooks through `$HOME`. A home Barry builds has
 * none of them, and with the memory credential store the key's token is never
 * written to the keychain, where it would replace the user's own login.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { barryCacheDir } from "@barry-rocks/sdk/services";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { CURSOR_REQUIREMENTS, cursorAgentPaths } from "./modes.js";

export const CREDENTIAL_ENV = "CURSOR_API_KEY";

/**
 * What Barry keeps true in a session's `cli-config.json` on every launch.
 * Cursor writes its own caches into the same file, so these are merged in.
 * An empty allowlist is what makes every native call ask Barry: a fresh home
 * otherwise allows `Shell(ls)` without asking.
 */
const SESSION_CONFIG = {
  version: 1,
  channel: "static",
  approvalMode: "allowlist",
  permissions: { allow: [], deny: [] },
};

export function requireCursorKey(env: Readonly<Record<string, string | undefined>>): string {
  const key = env[CREDENTIAL_ENV];
  if (!key) {
    throw new Error(`cursor runs only on the identity's ${CREDENTIAL_ENV}, and this session has none; define it on the identity or in its vault`);
  }
  return key;
}

/** Under Barry's cache: it survives a reboot, and its path has no spaces for hook commands to quote. */
export function cursorHomesRoot(): string {
  return join(barryCacheDir(), "cursor-homes");
}

export function cursorHome(sessionId: string): string {
  return join(cursorHomesRoot(), createHash("sha256").update(sessionId).digest("hex").slice(0, 12));
}

export function prepareCursorHome(sessionId: string): string {
  const home = cursorHome(sessionId);
  const configPath = join(home, ".cursor", "cli-config.json");
  mkdirSync(join(home, ".cursor"), { recursive: true, mode: 0o700 });
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    // A first launch, or a file cursor left half-written: Barry's keys are all that matter.
  }
  writeFileSync(configPath, `${JSON.stringify({ ...current, ...SESSION_CONFIG }, null, 2)}\n`, { mode: 0o600 });
  return home;
}

/** The session's own environment, run from `home`, with Barry's attribution. */
export function cursorEnv(config: SessionConfig, home: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(config.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return {
    ...env,
    HOME: home,
    AGENT_CLI_CREDENTIAL_STORE: "memory",
    BARRY_PROVIDER: "cursor",
    BARRY_SESSION_ID: config.sessionId,
  };
}

/**
 * A stdio MCP server is cursor-agent's child, so it would inherit the
 * session's home; it keeps the user's, where its own config and caches live,
 * unless its definition names one.
 */
export function keepUserHome(servers: SessionConfig["mcpServers"], home = homedir()): SessionConfig["mcpServers"] {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, "command" in server ? { ...server, env: { HOME: home, ...server.env } } : server]),
  );
}

/** Flags every cursor-agent invocation carries: keep the running executable stable for this session. */
export const PINNED_LAUNCH = ["--disable-auto-update"];

/** Resolve the current installation; version assessment happens centrally. */
export function resolveCursorAgent(home = homedir(), env: Readonly<Record<string, string | undefined>> = process.env): { command: string; pinned: boolean } {
  return { command: resolveHarnessCommand({ ...CURSOR_REQUIREMENTS, binary: { ...CURSOR_REQUIREMENTS.binary, paths: home === homedir() ? [] : cursorAgentPaths(home) } }, env), pinned: false };
}
