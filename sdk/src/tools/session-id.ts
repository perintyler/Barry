import type { ToolContext } from "./define-tool.js";

/**
 * Resolve the session id preferring the per-request context (set by the shared
 * HTTP MCP server) and falling back to the env var (CLI stdio mode). The shared
 * server has no per-session BARRY_SESSION_ID, so context.sessionId is the only
 * reliable source there.
 */
export function resolveSessionId(context?: ToolContext): string {
  const fromContext = context?.sessionId;
  if (fromContext) return fromContext;

  const sessionId = process.env.BARRY_SESSION_ID;
  if (!sessionId) throw new Error("No session ID available (BARRY_SESSION_ID not set)");
  return sessionId;
}
