/**
 * Start claude's live hosted session: the streaming Agent SDK query, built
 * from the same options the per-turn path uses — one config builds both, so a
 * flag, an MCP server or the system prompt cannot differ between them.
 *
 * The SDK is imported when the first turn opens the query, not here, so
 * starting a session that never runs a turn loads nothing.
 */
import type { Guarantees } from "@barry-rocks/sdk/adapters/harnesses";
import {envMs} from "@barry-rocks/sdk/sessions";
import type { Session, SessionConfig } from "@barry-rocks/sdk/sessions";
import { createSDKMessageMapper } from "../anthropic-compatible/event-mapping.js";
import { ClaudeLiveSession, type LiveQuery, type UserMessage } from "./live-session.js";

export interface ClaudeLiveStart {
  guarantees: Guarantees;
  /** How long an idle session keeps its process. */
  releaseAfterMs?: number;
  /** Seconds a tool call may wait for Barry’s ruling. */
  rulingWindow?: number;
}

export function startClaudeLive(config: SessionConfig, start: ClaudeLiveStart): Session {
  const mapMessage = createSDKMessageMapper();
  let openingAbort:AbortController|undefined;
  return new ClaudeLiveSession({
    id: config.sessionId,
    guarantees: start.guarantees,
    open: (prompt, resume, warm) => openStreamingQuery(config, prompt, resume, start.rulingWindow, warm,abort=>{openingAbort=abort;}),
    abortOpen:()=>openingAbort?.abort(),
    toEvents: (message) => mapMessage(message as Parameters<typeof mapMessage>[0]),
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
  warm = false,
  onAbort?:(abort:AbortController)=>void,
): Promise<LiveQuery> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const { query } = sdk;
  const startup = "startup" in sdk ? sdk.startup : undefined;
  const { buildSdkOptions } = await import("../anthropic-compatible/sdk-impl.js");
  const options = buildSdkOptions(config, {
      // Native exclusion and the PreToolUse gate enforce Barry policy.
      // Authorized MCP calls require no additional vendor approval.
      permissionMode: "bypassPermissions",
      ...(resume ? { resume } : {}),
    }, rulingWindow);
  if (typeof startup === "function") {
    const abort = new AbortController();
    onAbort?.(abort);
    const initializeTimeoutMs = envMs("BARRY_CLAUDE_INIT_TIMEOUT_MS",warm?60_000:120_000);
    const timer=setTimeout(()=>abort.abort(), initializeTimeoutMs);
    try {
      const ready = await startup({ options: { ...options, abortController: abort }, initializeTimeoutMs });
      return ready.query(prompt);
    } catch (error) { const expired=abort.signal.aborted; abort.abort(); if (expired) throw new Error(`Harness initialize timeout after ${initializeTimeoutMs}ms`, {cause:error}); throw error; }
    finally { clearTimeout(timer); }
  }
  return query({ prompt, options });
}
