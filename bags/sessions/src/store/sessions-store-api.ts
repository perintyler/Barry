/** Expose SQLite operations through promise-returning public names annotated with the independent sessions contract so implementation drift fails at this boundary; see docs/decisions/0013-session-store-and-mcp-admission.md. */

import type * as contract from "./sessions-contract.js";
import * as reads from "./sessions-sqlite-reads.js";
import * as writes from "./sessions-sqlite-writes.js";
import { generateId } from "@barry-rocks/sdk/ids";
import { workflowTurnsStore } from "./workflow-turns.js";
import { forgetSession, shouldPersist } from "./messages.js";
import {
  getName,
  formatSessionName,
  cleanSessionName,
  parseMetadata,
  rowToSession,
  formatSessionHistory,
} from "./session-helpers.js";


export const getSession: contract.GetSession = async (id) => reads.getSessionSqlite(id);
export const listSessions: contract.ListSessions = async (options) =>
  reads.listSessionsSqlite(options);
export const getActiveSessions: contract.GetActiveSessions = async () =>
  reads.getActiveSessionsSqlite();
export const getSessionStats: contract.GetSessionStats = async () =>
  reads.getSessionStatsSqlite();
export const searchSessions: contract.SearchSessions = async (query, limit, includeArchived) =>
  reads.searchSessionsSqlite(query, limit, includeArchived);

export const getSessionMessageCount: contract.GetSessionMessageCount = async (id) =>
  reads.getSessionMessageCountSqlite(id);
export const getSessionMessageCounts: contract.GetSessionMessageCounts = async (ids) =>
  reads.getSessionMessageCountsSqlite(ids);


export const getProviderSessionsBySession: contract.GetProviderSessionsBySession = async (
  sessionId,
) => reads.getProviderSessionsBySessionSqlite(sessionId);
export const getSessionByProviderSessionId: contract.GetSessionByProviderSessionId = async (
  providerSessionId,
) => reads.getSessionByProviderSessionIdSqlite(providerSessionId);
export const createProviderSession: contract.CreateProviderSession = async (data) =>
  writes.createProviderSessionSqlite(data);
export const endProviderSessionByProviderId: contract.EndProviderSessionByProviderId = async (
  providerSessionId,
) => {
  writes.endProviderSessionByProviderIdSqlite(providerSessionId);
};


export const getSessionMessages: contract.GetSessionMessages = async (sessionId, options) =>
  reads.getSessionMessagesSqlite(sessionId, options);
export const getMessageDetail: contract.GetMessageDetail = async (sessionId, sequence) =>
  reads.getMessageDetailSqlite(sessionId, sequence);
export const getSessionContext: contract.GetSessionContext = async (sessionId) =>
  reads.getSessionContextSqlite(sessionId);
export const searchMessages: contract.SearchMessages = async (query, options) =>
  reads.searchMessagesSqlite(query, options);
export const buildSessionHistoryContext: contract.BuildSessionHistoryContext = async (sessionId) =>
  reads.buildSessionHistoryContextSqlite(sessionId);
export const getLatestActivityBySessions: contract.GetLatestActivityBySessions = async (ids, access) =>
  reads.getLatestActivityBySessionsSqlite(ids, access);
export const getRecentToolCallsBySessions: contract.GetRecentToolCallsBySessions = async (
  ids,
  limitPerSession,
) => reads.getRecentToolCallsBySessionsSqlite(ids, limitPerSession);
export const getFirstUserMessages: contract.GetFirstUserMessages = async (ids) =>
  reads.getFirstUserMessagesSqlite(ids);


export const createSession: contract.CreateSession = async (data) => {
  writes.createSessionSqlite(data);
};
/**
 * `id` and `agent_token` are generated here rather than asked of the caller.
 *
 * The contract deliberately omits both: a session create has no caller who
 * knows either.
 */
export const createNamedSession: contract.CreateNamedSession = async (data) =>
  writes.createNamedSessionSqlite({
    id: generateId(),
    agent_token: null,
    ...(data as object),
  });
export const createInertSession: contract.CreateInertSession = async (data) =>
  writes.createInertSessionSqlite({
    id: generateId(),
    agent_token: null,
    ...(data as object),
  });
export const updateSession: contract.UpdateSession = async (id, updates) =>
  writes.updateSessionSqlite(id, updates);
export const updateSessionMetadata: contract.UpdateSessionMetadata = async (id, updates) => {
  writes.updateSessionMetadataSqlite(id, updates);
};
export const updateSessionMetadataNormalized: contract.UpdateSessionMetadataNormalized = async (
  id,
  updates,
) => writes.updateSessionMetadataNormalizedSqlite(id, updates);
export const issueWorkflowCredential: contract.IssueWorkflowCredential = async (id, expected) => writes.issueWorkflowCredentialSqlite(id, expected);
export const endSession: contract.EndSession = async (id, endReason) => {
  writes.endSessionSqlite(id, endReason);
};
export const deleteSession: contract.DeleteSession = async (id) => {
  writes.deleteSessionSqlite(id);
};
export const deleteSessionsByIdentity: contract.DeleteSessionsByIdentity = async (identityId) =>
  writes.deleteSessionsByIdentitySqlite(identityId);
export const archiveSession: contract.ArchiveSession = async (id) => {
  writes.archiveSessionSqlite(id);
};
export const archiveAllClosedSessions: contract.ArchiveAllClosedSessions = async () =>
  writes.archiveAllClosedSessionsSqlite();
export const markCrashedSessions: contract.MarkCrashedSessions = async (idleMs, excludeIds) =>
  writes.markCrashedSessionsSqlite(idleMs, excludeIds);


export const queuePrompt: contract.QueuePrompt = async (sessionId, content, options) =>
  writes.queuePromptSqlite(sessionId, content, options);
export const popPrompts: contract.PopPrompts = async (sessionId) =>
  writes.popPromptsSqlite(sessionId);
export const getPrompts: contract.GetPrompts = async (sessionId) =>
  reads.getPromptsSqlite(sessionId);
export const recordPromptDelivery: contract.RecordPromptDelivery = async (
  sessionId,
  content,
  options,
) => writes.recordPromptDeliverySqlite(sessionId, content, options);
export const updatePromptDeliveryByClientMessageId: contract.UpdatePromptDeliveryByClientMessageId =
  async (sessionId, clientMessageId, delivery, options) =>
    writes.updatePromptDeliveryByClientMessageIdSqlite(
      sessionId,
      clientMessageId,
      delivery,
      options,
    );
export const claimFailedPromptRetry: contract.ClaimFailedPromptRetry = async (
  sessionId,
  clientMessageId,
  content,
) => writes.claimFailedPromptRetrySqlite(sessionId, clientMessageId, content);
export const getMessageByClientMessageId: contract.GetMessageByClientMessageId = async (
  sessionId,
  clientMessageId,
) => reads.getMessageByClientMessageIdSqlite(sessionId, clientMessageId);


export const appendMessage = writes.appendMessageSqlite;


export const deleteMessagesOlderThan: contract.DeleteMessagesOlderThan = async (cutoff, options) =>
  writes.deleteMessagesOlderThanSqlite(cutoff, options);


/** Keep the compatibility namespaces complete; transport clients override selected members after spreading them. */
export const Sessions = {
  archiveAllClosed: archiveAllClosedSessions,
  get: getSession,
  list: listSessions,
  getActive: getActiveSessions,
  create: createSession,
  createNamed: createNamedSession,
  createInert: createInertSession,
  update: updateSession,
  updateMetadata: updateSessionMetadata,
  updateMetadataNormalized: updateSessionMetadataNormalized,
  end: endSession,
  delete: deleteSession,
  getMessageCount: getSessionMessageCount,
  archive: archiveSession,
  markCrashed: markCrashedSessions,
  search: searchSessions,

  getStats: getSessionStats,
  getName,
  formatName: formatSessionName,
  cleanName: cleanSessionName,
  parseMetadata,
  rowToSession,
};

/**
 * `end` and `getActive` are deliberately absent.
 *
 * They were `endProviderSession(id)` and `getActiveProviderSession(sessionId)`
 * -- legacy queries against `provider_sessions`, which migration 041
 * dropped. Neither was ever ported to SQLite and neither has a caller: a
 * repo-wide search for both names (and for `ProviderSessions.getActive`)
 * found only the re-export, the facade entry and the probe allow-list. There
 * was nothing to repoint them at, so they are gone rather than left pointing
 * at a table that no longer exists.
 *
 * `endByProviderId` is the live one and covers the same need: callers end a
 * provider session by the provider's own id, not by our surrogate key.
 */
export const ProviderSessions = {
  create: createProviderSession,
  endByProviderId: endProviderSessionByProviderId,
  getBySession: getProviderSessionsBySession,
  getSessionByProviderId: getSessionByProviderSessionId,
};

export const Messages = {
  queuePrompt,
  recordPromptDelivery,
  updatePromptDeliveryByClientMessageId,
  getPrompts,
  popPrompts,
  getMessageByClientMessageId,
  forgetSession,
  shouldPersist,
  appendMessage,
  deleteOlderThan: deleteMessagesOlderThan,
  formatSessionHistory,
  buildSessionHistoryContext,
  getSessionMessages,
  getSessionContext,
  searchMessages,
};

import * as processes from "./processes.js";

export const recordProcessStart: contract.RecordProcessStart = async (input) => processes.recordProcessStart(input);
export const markProcessInstanceEnded: contract.MarkProcessInstanceEnded = async (instance, reason) => processes.markProcessInstanceEnded(instance, reason);
export const markProcessEnded: contract.MarkProcessEnded = async (sessionId, reason) => processes.markProcessEnded(sessionId, reason);
export const stampLiveness: contract.StampLiveness = async (stamps) => processes.stampLiveness(stamps);
export const getLiveProcess: contract.GetLiveProcess = async (sessionId) => processes.getLiveProcess(sessionId);
export const getLiveProcessesBySessions: contract.GetLiveProcessesBySessions = async (sessionIds) => processes.getLiveProcessesBySessions(sessionIds);
export const listLiveProcesses: contract.ListLiveProcesses = async () => processes.listLiveProcesses();
export const listProcesses: contract.ListProcesses = async (sessionId) => processes.listProcesses(sessionId);

export const Processes = {
  recordStart: recordProcessStart,
  markEnded: markProcessEnded,
  markInstanceEnded: markProcessInstanceEnded,
  stampLiveness,
  getLive: getLiveProcess,
  getLiveBySessions: getLiveProcessesBySessions,
  listLive: listLiveProcesses,
  list: listProcesses,
  listReapCandidates: processes.listReapCandidates,
};

/** Durable workflow/session binding journal, owned by the Sessions store. */
export const workflowSessionJournal = workflowTurnsStore;

export const listBoundSessions = async () => reads.listBoundSessionsSqlite();
