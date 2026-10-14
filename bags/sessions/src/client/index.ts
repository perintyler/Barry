import { identityRouting } from "../store/identity-routing.js";
/**
 * The session storage client — the ONLY sanctioned interface to the
 * sessions / messages / provider_sessions stores from outside `../store`.
 *
 * Every process reads and writes a session's SQLite store directly (WAL keeps
 * concurrent writers safe, and the store numbers each message as it inserts
 * it), routed to the store that holds the session (`identityRouting`). The
 * delivery calls are the exception: their state lives in the sessions API, so
 * they ask it (`./delivery.ts`).
 *
 * Deliberately NOT here:
 * - prompts / agent questions (interaction surface, own tables)
 * - Events / Identities / Bounds / Traits / Users (other domains)
 * - the raw `db` handle — a consumer that needs raw Kysely against the
 *   session tables is a consumer this seam has failed; add a function.
 */


import {
  getSession as dbGetSession,
  listSessions as dbListSessions,
  listBoundSessions as dbListBoundSessions,
  getActiveSessions as dbGetActiveSessions,
  getSessionStats as dbGetSessionStats,
  searchSessions as dbSearchSessions,



  createNamedSession as dbCreateNamedSession,
  createInertSession as dbCreateInertSession,

  getProviderSessionsBySession as dbGetProviderSessionsBySession,
  getSessionByProviderSessionId as dbGetSessionByProviderSessionId,
  createSession as dbCreateSession,
  updateSession as dbUpdateSession,
  endSession as dbEndSession,
  issueWorkflowCredential as dbIssueWorkflowCredential,
  deleteSession as dbDeleteSession,
  deleteSessionsByIdentity as dbDeleteSessionsByIdentity,
  updateSessionMetadata as dbUpdateSessionMetadata,
  updateSessionMetadataNormalized as dbUpdateSessionMetadataNormalized,
  createProviderSession as dbCreateProviderSession,
  endProviderSessionByProviderId as dbEndProviderSessionByProviderId,
  markCrashedSessions as dbMarkCrashedSessions,
  archiveAllClosedSessions as dbArchiveAllClosedSessions,
  archiveSession as dbArchiveSession,
  appendMessage as dbAppendMessage,
  getSessionMessages as dbGetSessionMessages,
  getSessionMessageCount as dbGetSessionMessageCount,
  getSessionMessageCounts as dbGetSessionMessageCounts,
  getLatestActivityBySessions as dbGetLatestActivityBySessions,
  getRecentToolCallsBySessions as dbGetRecentToolCallsBySessions,
  getFirstUserMessages as dbGetFirstUserMessages,
  queuePrompt as dbQueuePrompt,
  popPrompts as dbPopPrompts,
  getPrompts as dbGetPrompts,
  recordPromptDelivery as dbRecordPromptDelivery,
  updatePromptDeliveryByClientMessageId as dbUpdatePromptDeliveryByClientMessageId,
  claimFailedPromptRetry as dbClaimFailedPromptRetry,
  getMessageByClientMessageId as dbGetMessageByClientMessageId,
  getMessageDetail as dbGetMessageDetail,
  getSessionContext as dbGetSessionContext,
  searchMessages as dbSearchMessages,
  buildSessionHistoryContext as dbBuildSessionHistoryContext,
  Messages as DbMessages,
  Sessions as DbSessions,
  ProviderSessions as DbProviderSessions,
  Processes as DbProcesses,
  recordProcessStart as dbRecordProcessStart,
  markProcessEnded as dbMarkProcessEnded,
  markProcessInstanceEnded as dbMarkProcessInstanceEnded,
  stampLiveness as dbStampLiveness,
  getLiveProcess as dbGetLiveProcess,
  getLiveProcessesBySessions as dbGetLiveProcessesBySessions,
  listLiveProcesses as dbListLiveProcesses,
  listProcesses as dbListProcesses,
  workflowSessionJournal as dbWorkflowSessionJournal,
} from "@barry-rocks/sessions-bag/store/sessions-store-api";
import {
  forgetSession as dbForgetSession,
  shouldPersist as dbShouldPersist,
} from "@barry-rocks/sessions-bag/store/messages";
import {
  formatSessionHistory as dbFormatSessionHistory,
} from "@barry-rocks/sessions-bag/store/session-helpers";
import type { WorkflowSessionJournalStore } from "@barry-rocks/sdk/internal/sessions";
import { promptQueued } from "./delivery.js";

export {
  waitForPrompts,
  registerListener,
  unregisterListener,
  getListeners,
  recordWake,
  hostDelivery,
  type Delivery,
  type SessionListeners,
} from "./delivery.js";

// The delivery vocabulary and the one formatter, re-exported here so a caller
// that already depends on the client seam does not take a second subpath to
// find out what a `delivery` value means.
export {
  formatInboxMessage,
  formatInboxMessages,
  strongestGuarantee,
  isDeliveryGuarantee,
  isListenerKind,
  DELIVERY_GUARANTEES,
  type DeliveryGuarantee,
  type Listener,
  type ListenerKind,
  type BudgetVerdict,
} from "../delivery/index.js";

export type {
  PromptRecord,
  PromptEnqueueResult,
  PromptDeliveryState,
  ClientMessageRecord,
  SessionRecord,
  SessionMetadata,
  SessionStats,
  ProviderSessionRecord,
  SearchMessageResult,
} from "@barry-rocks/sessions-bag/store/session-records";

const store = identityRouting({
  dbArchiveAllClosedSessions: dbArchiveAllClosedSessions,
  dbArchiveSession: dbArchiveSession,
  dbBuildSessionHistoryContext: dbBuildSessionHistoryContext,
  dbClaimFailedPromptRetry: dbClaimFailedPromptRetry,
  dbCreateInertSession: dbCreateInertSession,
  dbCreateNamedSession: dbCreateNamedSession,
  dbCreateProviderSession: dbCreateProviderSession,
  dbCreateSession: dbCreateSession,
  dbDeleteSession: dbDeleteSession,
  dbDeleteSessionsByIdentity: dbDeleteSessionsByIdentity,
  dbEndProviderSessionByProviderId: dbEndProviderSessionByProviderId,
  dbEndSession: dbEndSession,
  dbIssueWorkflowCredential,
  dbGetActiveSessions: dbGetActiveSessions,
  dbGetFirstUserMessages: dbGetFirstUserMessages,
  dbGetLatestActivityBySessions: dbGetLatestActivityBySessions,
  dbGetMessageByClientMessageId: dbGetMessageByClientMessageId,
  dbGetMessageDetail: dbGetMessageDetail,
  dbGetPrompts: dbGetPrompts,
  dbGetProviderSessionsBySession: dbGetProviderSessionsBySession,
  dbGetRecentToolCallsBySessions: dbGetRecentToolCallsBySessions,
  dbGetSession: dbGetSession,
  dbGetSessionByProviderSessionId: dbGetSessionByProviderSessionId,
  dbGetSessionContext: dbGetSessionContext,
  dbGetSessionMessageCount: dbGetSessionMessageCount,
  dbGetSessionMessageCounts: dbGetSessionMessageCounts,
  dbGetSessionMessages: dbGetSessionMessages,
  dbGetSessionStats: dbGetSessionStats,
  dbListSessions: dbListSessions,
  dbListBoundSessions: dbListBoundSessions,
  dbMarkCrashedSessions: dbMarkCrashedSessions,
  dbAppendMessage: dbAppendMessage,
  dbPopPrompts: dbPopPrompts,
  dbQueuePrompt: dbQueuePrompt,
  dbRecordPromptDelivery: dbRecordPromptDelivery,
  dbSearchMessages: dbSearchMessages,
  dbSearchSessions: dbSearchSessions,
  dbUpdatePromptDeliveryByClientMessageId: dbUpdatePromptDeliveryByClientMessageId,
  dbUpdateSession: dbUpdateSession,
  dbUpdateSessionMetadata: dbUpdateSessionMetadata,
  dbUpdateSessionMetadataNormalized: dbUpdateSessionMetadataNormalized,
  dbWorkflowSessionJournal: dbWorkflowSessionJournal,
});


export const getSession = store.dbGetSession;
export const listSessions = store.dbListSessions;
export const getActiveSessions = store.dbGetActiveSessions;
export const getSessionStats = store.dbGetSessionStats;
export const searchSessions = store.dbSearchSessions;
// The three exact-match directory readers were here — `getRecentByDirectory`,
// `getMostRecentSession`, `getUniqueDirectories`. Their callers are gone, and a
// directory listing uses `listSessions({ directory })`.
// findSessionByLinearIssue / findSessionByGitHubPR were here. Each was a
// metadata equality filter with its own SQL. Callers now use
// `listSessions({ metadata: … , limit: 1 })` — see SessionService, which holds
// the only two callers and the note on why `includeArchived` matters there.
export const getProviderSessionsBySession = store.dbGetProviderSessionsBySession;
export const getSessionByProviderSessionId = store.dbGetSessionByProviderSessionId;
export const getSessionMessages = store.dbGetSessionMessages;
export const getSessionMessageCount = store.dbGetSessionMessageCount;
export const getSessionMessageCounts = store.dbGetSessionMessageCounts;
export const getMessageDetail = store.dbGetMessageDetail;
export const getSessionContext = store.dbGetSessionContext;
export const searchMessages = store.dbSearchMessages;
export const buildSessionHistoryContext = store.dbBuildSessionHistoryContext;
// point-guard's supervisor read these straight off the store while its
// own worker already went through this client -- writes to one store, reads
// from another, inside one process. Routing them here closes that.
export const getFirstUserMessages = store.dbGetFirstUserMessages;
// Prompts go through this client like every other session call, so the queue
// the API writes is the queue `check_prompts` and the engine's bag proxy
// drain. When those two took `popPrompts` straight off a store instead, a
// user's follow-up message could simply never arrive.
//
// A prompt queued (or a failed one claimed for retry) wakes the delivery
// host's waiters at once when this process is the host; any other process's
// queue is found by the host's next read of the store.
export const queuePrompt: typeof dbQueuePrompt = async (sessionId, content, options?) => {
  const result = await store.dbQueuePrompt(sessionId, content, options);
  // A duplicate was queued by an earlier call, which already woke its waiters.
  if (!result.duplicate) promptQueued(sessionId);
  return result;
};
export const popPrompts = store.dbPopPrompts;
export const getPrompts = store.dbGetPrompts;
export const recordPromptDelivery = store.dbRecordPromptDelivery;
export const updatePromptDeliveryByClientMessageId = store.dbUpdatePromptDeliveryByClientMessageId;
export const claimFailedPromptRetry: typeof dbClaimFailedPromptRetry = async (sessionId, clientMessageId, content) => {
  const record = await store.dbClaimFailedPromptRetry(sessionId, clientMessageId, content);
  if (record) promptQueued(sessionId);
  return record;
};
export const getMessageByClientMessageId = store.dbGetMessageByClientMessageId;
export const getLatestActivityBySessions = store.dbGetLatestActivityBySessions;
export const getRecentToolCallsBySessions = store.dbGetRecentToolCallsBySessions;

/** Durable workflow-turn receipts, in the Sessions-owned store. */
export const workflowSessionJournal: WorkflowSessionJournalStore = store.dbWorkflowSessionJournal;
// shouldPersist is pure (Set lookup, no DB), like formatSessionHistory.
export const shouldPersist = dbShouldPersist;

// formatSessionHistory is a pure function (no DB).
export const formatSessionHistory = dbFormatSessionHistory;

// forgetSession drops in-memory tool-call correlation state; no DB.
export const forgetSession = dbForgetSession;


export type {
  ProcessRecord,
  ProcessInstance,
  RecordProcessInput,
  ProcessLivenessStamp,
} from "../store/processes.js";

export const recordProcessStart: typeof dbRecordProcessStart = (input) => dbRecordProcessStart(input);
export const markProcessInstanceEnded: typeof dbMarkProcessInstanceEnded = (instance, reason) => dbMarkProcessInstanceEnded(instance, reason);
export const markProcessEnded: typeof dbMarkProcessEnded = (sessionId, reason) => dbMarkProcessEnded(sessionId, reason);
export const stampLiveness: typeof dbStampLiveness = (stamps) => dbStampLiveness(stamps);
export const getLiveProcess: typeof dbGetLiveProcess = (sessionId) => dbGetLiveProcess(sessionId);
export const getLiveProcessesBySessions: typeof dbGetLiveProcessesBySessions = (sessionIds) => dbGetLiveProcessesBySessions(sessionIds);
export const listLiveProcesses: typeof dbListLiveProcesses = () => dbListLiveProcesses();
export const listProcesses: typeof dbListProcesses = (sessionId) => dbListProcesses(sessionId);
export const listReapCandidates = async (limit: number) => DbProcesses.listReapCandidates(limit);

export const Processes = {
  recordStart: recordProcessStart,
  markEnded: markProcessEnded,
  markInstanceEnded: markProcessInstanceEnded,
  stampLiveness,
  getLive: getLiveProcess,
  getLiveBySessions: getLiveProcessesBySessions,
  listLive: listLiveProcesses,
  list: listProcesses,
  listReapCandidates,
};


export const createSession = store.dbCreateSession;
export const createNamedSession = store.dbCreateNamedSession;
export const createInertSession = store.dbCreateInertSession;
export const updateSession = store.dbUpdateSession;
export const issueWorkflowCredential = store.dbIssueWorkflowCredential;

export const endSession = store.dbEndSession;
export const deleteSession = store.dbDeleteSession;
// The identity-deletion fanout: `sessions.identity_id` has no foreign key to
// cascade through, so it is an explicit call like any other write.
export const deleteSessionsByIdentity = store.dbDeleteSessionsByIdentity;
export const updateSessionMetadata = store.dbUpdateSessionMetadata;
export const updateSessionMetadataNormalized = store.dbUpdateSessionMetadataNormalized;
export const createProviderSession = store.dbCreateProviderSession;
export const endProviderSessionByProviderId = store.dbEndProviderSessionByProviderId;
export const markCrashedSessions = store.dbMarkCrashedSessions;
export const archiveSession = store.dbArchiveSession;
export const archiveAllClosedSessions = store.dbArchiveAllClosedSessions;

/**
 * Append a message and answer the sequence the store gave it (null: nothing
 * stored). The insert assigns the sequence under the store's write lock, so
 * it is correct from any process, and the caller advertises the stored value
 * instead of one it guessed.
 */
export const appendMessage = store.dbAppendMessage;

export const Messages = DbMessages;

/**
 * Namespace views over the routed members, for call sites that use
 * Sessions.get, Sessions.list, etc.
 */
export const Sessions = {
  ...DbSessions,
  get: getSession,
  list: listSessions,

  getActive: getActiveSessions,
  create: createSession,
  createNamed: createNamedSession,
  createInert: createInertSession,
  update: updateSession,
  updateMetadata: updateSessionMetadata,
  updateSessionMetadata,
  end: endSession,
  delete: deleteSession,
  getMessageCount: getSessionMessageCount,
  archiveAllClosed: archiveAllClosedSessions,
  markCrashed: markCrashedSessions,
  search: searchSessions,
  getStats: getSessionStats,
};

export const ProviderSessions = {
  ...DbProviderSessions,
  create: createProviderSession,
  endByProviderId: endProviderSessionByProviderId,
  getBySession: getProviderSessionsBySession,
  getSessionByProviderId: getSessionByProviderSessionId,
};

export const listBoundSessions = store.dbListBoundSessions;
export async function convertSessionBounds(nameOf: (id: number) => string | undefined) {
  const converted: string[] = [];
  const unknown: { id: string; boundId: number }[] = [];
  for (const row of await listBoundSessions()) {
    const name = row.bound_id === null ? undefined : nameOf(row.bound_id);
    if (!name) { if (row.bound_id !== null) unknown.push({ id: row.id, boundId: row.bound_id }); continue; }
    await updateSession(row.id, { bounds: [...new Set([...row.bounds, name])], bound_id: null });
    converted.push(row.id);
  }
  return { converted, unknown };
}
