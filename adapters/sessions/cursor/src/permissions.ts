// Write native deny rules into the workspace; caller denials override any selected native-tool allowance.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-006

/**
 * Only permission kinds enforced by the pinned CLI belong here. Missing
 * names are reported instead of quietly dropping their denial.
 */
const CURSOR_PERMISSION_KIND: Record<string, string> = {
  Bash: "Shell", Shell: "Shell", WriteShellStdin: "Shell",
  Read: "Read", Write: "Write", Edit: "Write", Delete: "Write", WebFetch: "WebFetch",
};

export type CursorPermissions = {
  /** Permission strings for `.cursor/cli.json`, e.g. `Shell(*)`. */
  deny: string[];
  /**
   * Denials Cursor cannot express. Non-empty means the caller's guarantee is
   * partial, and saying so is the difference between a guard and the
   * appearance of one.
   */
  unenforceable: string[];
};

export function buildCursorPermissions(deniedTools: string[] = []): CursorPermissions {
  const deny = new Set<string>();
  const unenforceable: string[] = [];

  for (const tool of deniedTools) {
    // MCP tools are already filtered per session by the Barry MCP server, which
    // simply does not offer a denied tool to the agent.
    if (tool.startsWith("mcp__")) continue;

    const kind = CURSOR_PERMISSION_KIND[tool];
    if (kind === undefined || kind === null) {
      unenforceable.push(tool);
      continue;
    }
    deny.add(`${kind}(*)`);
  }

  return { deny: [...deny].sort(), unenforceable };
}

/**
 * The `.cursor/cli.json` body for a session.
 *
 * Only `permissions` is written: everything else in that file is the user's,
 * and the session config is merged over the user's global config rather than
 * replacing it.
 */
export function buildCursorCliConfig(deniedTools: string[] = []): {
  config: { permissions: { allow: string[]; deny: string[] } };
  unenforceable: string[];
} {
  const { deny, unenforceable } = buildCursorPermissions(deniedTools);
  return { config: { permissions: { allow: [], deny } }, unenforceable };
}
