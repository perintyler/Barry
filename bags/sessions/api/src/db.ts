/** Adapt the single session vocabulary over the session and configuration stores; see docs/decisions/0014-discovery-vault-and-session-budgets.md. */
import {
  getSession as _getSession,
  listSessions as _listSessions,
  getActiveSessions as _getActiveSessions,
  updateSessionMetadata,
  issueWorkflowCredential,
  type SessionRecord,
  shouldPersist,
  appendMessage,
  forgetSession,
  formatSessionHistory,
  buildSessionHistoryContext,
  getSessionMessages,
  getMessageDetail,
  createNamedSession,
  // Preserve the raw record for callers that need status and metadata.
  updateSession as _updateSession,
} from "@barry-rocks/sessions-bag/client";

import type { Session } from "./types.js";

export type { HistoryEntry } from "@barry-rocks/sessions-bag/store/session-helpers";

// Session adapters: convert between db package SessionRecord and
// barry server's flat Session type

function sessionRecordToFlat(record: SessionRecord): Session {
  const meta = record.metadata;
  return {
    id: record.id,
    active: record.active,
    user_id: record.user_id,
    agent_token: record.agent_token,
    created_at: record.created_at,
    ended_at: record.ended_at,
    working_directory: meta.working_directory ?? null,
    git_branch: meta.git_branch ?? null,
    git_remote: meta.git_remote ?? null,
    transcript_path: meta.transcript_path ?? null,
    permission_mode: meta.permission_mode ?? null,
    source: meta.source ?? null,
    end_reason: meta.end_reason ?? null,
    hostname: meta.hostname ?? null,
    user: meta.user ?? null,
    name: meta.name ?? null,
    web_enabled: meta.web_enabled ?? true,
    provider: (meta.provider as string | undefined) ?? null,
    model: (meta.model as string | undefined) ?? null,
    identity_id: record.identity_id,
  };
}

export async function getSession(id: string): Promise<Session | undefined> {
  const record = await _getSession(id);
  return record ? sessionRecordToFlat(record) : undefined;
}

export async function getActiveSessions(): Promise<Session[]> {
  const records = await _getActiveSessions();
  return records.map(sessionRecordToFlat);
}


/**
 * The highest sequence a session's store holds, or -1 when it holds none:
 * where a live session's advertised sequence starts.
 */
export async function lastMessageSequence(sessionId: string): Promise<number> {
  const { messages } = await getSessionMessages(sessionId, { limit: 1, summary: true });
  const sequence = messages[0]?.sequence;
  return typeof sequence === "number" ? sequence : -1;
}

export {
  shouldPersist,
  appendMessage,
  forgetSession,
  formatSessionHistory,
  buildSessionHistoryContext,
  getSessionMessages,
  getMessageDetail,
  // Sessions — raw records for callers that need status and metadata.
  createNamedSession,
  _getSession as getSessionRecord,
  _listSessions as listSessionRecords,
  _updateSession as updateSessionRecord,
  updateSessionMetadata,
  issueWorkflowCredential,
};
