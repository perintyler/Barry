/**
 * Start claude's live hosted session: the streaming Agent SDK query, built
 * from the same options the per-turn path uses — one config builds both, so a
 * flag, an MCP server or the system prompt cannot differ between them.
 *
 * The SDK is imported when the first turn opens the query, not here, so
 * starting a session that never runs a turn loads nothing.
 */
import type { Guarantees } from "@barry-rocks/sdk/adapters/harnesses";
import type { Session, SessionConfig } from "@barry-rocks/sdk/sessions";
import { processSDKMessage } from "../anthropic-compatible/event-mapping.js";
import { ClaudeLiveSession, type LiveQuery, type UserMessage } from "./live-session.js";

export interface ClaudeLiveStart {
  guarantees: Guarantees;
  /** How long an idle session keeps its process. */
  releaseAfterMs?: number;
  /** Seconds a tool call may wait for Barry’s ruling. */
  rulingWindow?: number;
}

export function startClaudeLive(config: SessionConfig, start: ClaudeLiveStart): Session {
  return new ClaudeLiveSession({
    id: config.sessionId,
    guarantees: start.guarantees,
    open: (prompt, resume) => openStreamingQuery(config, prompt, resume, start.rulingWindow),
    toEvents: (message) => processSDKMessage(message as Parameters<typeof processSDKMessage>[0]),
    structuredTurn: async function* (content, schema, signal) {
      const { runOneShot } = await import("../anthropic-compatible/sdk-impl.js");
      yield* runOneShot(config, content, schema, signal);
    },
    ...(config.resume?.harnessSessionId ? { resume: config.resume.harnessSessionId } : {}),
    ...(start.releaseAfterMs ? { releaseAfterMs: start.releaseAfterMs } : {}),
  });
}

async function openStreamingQuery(
  config: SessionConfig,
  prompt: AsyncIterable<UserMessage>,
  resume: string | undefined,
  rulingWindow?: number,
): Promise<LiveQuery> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { buildSdkOptions } = await import("../anthropic-compatible/sdk-impl.js");
  return query({
    prompt,
    options: buildSdkOptions(config, {
      // Native exclusion and the PreToolUse gate enforce Barry policy.
      // Authorized MCP calls require no additional vendor approval.
      permissionMode: "bypassPermissions",
      ...(resume ? { resume } : {}),
    }, rulingWindow),
  });
}
