import { TraitSchema } from "../identities/types.js";
import { z } from "zod";
import { route } from "./route.js";
import { ActionAckSchema } from "../errors.js";
import { ActionResponseSchema, AttachRendererRequestSchema, CreateSessionRequestSchema, CreateSessionResponseSchema, DetachRendererRequestSchema, MessageDetailResponseSchema, MessageListResponseSchema, PersistMessageRequestSchema, RendererAttachmentSchema, ResolvedToolsResponseSchema as ResolvedToolsEnvelopeSchema, SearchResponseSchema, SendMessageRequestSchema, SendMessageResponseSchema as SendMessageEnvelopeSchema, SessionSchema, SessionListResponseSchema, UpdateSessionRequestSchema } from "../sessions/types.js";
import { ModelCatalogResponseSchema } from "../adapters/models/types.js";

const ResolvedToolsResponseSchema = ResolvedToolsEnvelopeSchema.extend({
  traits: ResolvedToolsEnvelopeSchema.shape.traits.extend({ available: z.array(TraitSchema) }),
});
const BackfillSessionRequest = z.object({ transcriptPath: z.string().optional() }).default({});
const SendMessageResponseSchema = SendMessageEnvelopeSchema.omit({ ok: true });
const SessionIdsResponseSchema = z.strictObject({ sessions: z.array(z.strictObject({ id: z.string() })), nextCursor: z.string().nullable() });
const SessionListingResponseSchema = z.union([SessionListResponseSchema, SessionIdsResponseSchema]);

const GuaranteeRequest = z.object({ sessionIds: z.array(z.string().min(1).max(500)).max(1000) });
const GuaranteesResponse = z.strictObject({
  guarantees: z.record(z.string(), z.strictObject({ guarantee: z.string(), listeners: z.array(z.unknown()) })),
});

const OpaqueEntity = z.record(z.string(), z.unknown());

const CompactSessionRequest = z.object({ targetTokens: z.number().int().min(1).optional() }).strict();
const NativeSessionRequest = z.object({ sessionId: z.string() }).strict();
const SessionChangeSummaryResponse = z.object({ files: z.array(OpaqueEntity), additions: z.number().int(), deletions: z.number().int() }).strict();
const SessionContextResponse = z.object({ context: z.unknown().nullable(), message: z.string().optional() }).strict();
const SessionTranscriptResponse = z.object({ entries: z.array(OpaqueEntity) }).strict();
const SessionWorktreeResponse = z.object({ message: z.string().optional(), mergeSessionId: z.string().optional() }).strict();
const StatusResponse = z.object({ hostname: z.string(), user: z.string(), activeSessions: z.number().int().nonnegative(), uptime: z.number().nonnegative() }).strict();

export const sessionsRoutes = {
  listDeliveryGuarantees: route({ method: "post", path: "/prompts/guarantee", operationId: "listDeliveryGuarantees", body: GuaranteeRequest, responses: { 200: GuaranteesResponse } }),
  listSessions: route({ method: "get", path: "/sessions", operationId: "listSessions", query: z.object({ "identityId": z.number().int().min(1).optional(), "cursor": z.string().optional(), "limit": z.number().int().min(1).max(100).optional(), "query": z.string().optional(), "active": z.boolean().optional(), "includeArchived": z.boolean().optional(), "fields": z.literal("id").optional(), "order": z.enum(["activity", "created_at"]).optional(), "hasMessages": z.boolean().describe("Return only sessions with at least one message, so a client that hides message-less sessions gets a full page of renderable rows.").optional() }), responses: { 200: SessionListingResponseSchema } }),
  createSession: route({ method: "post", path: "/sessions", operationId: "createSession", body: CreateSessionRequestSchema, responses: { 201: CreateSessionResponseSchema } }),
  getSession: route({ method: "get", path: "/sessions/{sessionId}", operationId: "getSession", params: z.object({ "sessionId": z.string() }), responses: { 200: SessionSchema } }),
  updateSession: route({ method: "patch", path: "/sessions/{sessionId}", operationId: "updateSession", params: z.object({ "sessionId": z.string() }), body: UpdateSessionRequestSchema, responses: { 200: SessionSchema } }),
  archiveSession: route({ method: "delete", path: "/sessions/{sessionId}", operationId: "archiveSession", params: z.object({ "sessionId": z.string() }), responses: { 204: null } }),
  listMessages: route({ method: "get", path: "/sessions/{sessionId}/messages", operationId: "listMessages", params: z.object({ "sessionId": z.string() }), query: z.object({ "after": z.number().int().min(-1).optional().describe("Answer the messages after this sequence; -1 starts at the first"), "before": z.number().int().min(0).optional(), "limit": z.number().int().min(1).max(5000).optional(), "summary": z.boolean().optional() }), responses: { 200: MessageListResponseSchema } }),
  sendMessage: route({ method: "post", path: "/sessions/{sessionId}/message", operationId: "sendMessage", params: z.object({ "sessionId": z.string() }), body: SendMessageRequestSchema, responses: { 200: SendMessageResponseSchema } }),
  listModels: route({ method: "get", path: "/models", operationId: "listModels", query: z.object({ "repoPath": z.string().optional() }), responses: { 200: ModelCatalogResponseSchema } }),
  getMessageDetail: route({ method: "get", path: "/sessions/{sessionId}/messages/{sequence}/detail", operationId: "getMessageDetail", params: z.object({ "sessionId": z.string(), "sequence": z.number().int() }), responses: { 200: MessageDetailResponseSchema } }),
  getResolvedSessionTools: route({ method: "get", path: "/sessions/{sessionId}/tools/resolved", operationId: "getResolvedSessionTools", params: z.object({ "sessionId": z.string() }), responses: { 200: ResolvedToolsResponseSchema } }),
  previewSessionTools: route({ method: "get", path: "/sessions/{sessionId}/tools/preview", operationId: "previewSessionTools", params: z.object({ "sessionId": z.string() }), query: z.object({ "traits": z.string().optional(), "namespaces": z.string().optional(), "tools": z.string().optional() }), responses: { 200: ResolvedToolsResponseSchema } }),
  stopSession: route({ method: "post", path: "/sessions/{sessionId}/stop", operationId: "stopSession", params: z.object({ "sessionId": z.string() }), responses: { 200: ActionResponseSchema } }),
  interruptSession: route({ method: "post", path: "/sessions/{sessionId}/interrupt", operationId: "interruptSession", params: z.object({ "sessionId": z.string() }), responses: { 200: ActionResponseSchema } }),
  attachRenderer: route({ method: "post", path: "/sessions/{sessionId}/attach", operationId: "attachRenderer", params: z.object({ "sessionId": z.string() }), body: AttachRendererRequestSchema, responses: { 200: RendererAttachmentSchema } }),
  detachRenderer: route({ method: "post", path: "/sessions/{sessionId}/detach", operationId: "detachRenderer", params: z.object({ "sessionId": z.string() }), body: DetachRendererRequestSchema, responses: { 200: ActionResponseSchema } }),
  searchSessions: route({ method: "get", path: "/sessions/search", operationId: "searchSessions", query: z.object({ "q": z.string(), "limit": z.number().int().min(1).max(50).optional(), "session_id": z.string().optional(), "role": z.enum(["user", "assistant"]).optional() }), responses: { 200: SearchResponseSchema } }),
  persistMessage: route({ method: "post", path: "/sessions/{sessionId}/messages/persist", operationId: "persistMessage", params: z.object({ "sessionId": z.string() }), body: PersistMessageRequestSchema, responses: { 200: ActionAckSchema } }),
  backfillSession: route({ method: "post", path: "/sessions/{sessionId}/backfill", operationId: "backfillSession", params: z.object({ sessionId: z.string() }), body: BackfillSessionRequest, responses: { 202: ActionAckSchema } }),
  getSessionContext: route({ method: "get", path: "/sessions/{sessionId}/context", operationId: "getSessionContext", params: z.object({ "sessionId": z.string() }), responses: { 200: SessionContextResponse } }),
  compactSession: route({ method: "post", path: "/sessions/{sessionId}/compact", operationId: "compactSession", params: z.object({ "sessionId": z.string() }), body: CompactSessionRequest, responses: { 200: ActionResponseSchema } }),
  mergeSessionWorktree: route({ method: "post", path: "/sessions/{sessionId}/merge-worktree", operationId: "mergeSessionWorktree", params: z.object({ "sessionId": z.string() }), responses: { 200: SessionWorktreeResponse } }),
  discardSessionWorktree: route({ method: "post", path: "/sessions/{sessionId}/discard-worktree", operationId: "discardSessionWorktree", params: z.object({ "sessionId": z.string() }), responses: { 200: SessionWorktreeResponse } }),
  getSessionTranscript: route({ method: "get", path: "/sessions/{sessionId}/transcript", operationId: "getSessionTranscript", params: z.object({ "sessionId": z.string() }), responses: { 200: SessionTranscriptResponse } }),
  getSessionChangeSummary: route({ method: "get", path: "/sessions/{sessionId}/changes", operationId: "getSessionChangeSummary", params: z.object({ "sessionId": z.string() }), responses: { 200: SessionChangeSummaryResponse } }),
  startNativeSession: route({ method: "post", path: "/sessions/start", operationId: "startNativeSession", body: NativeSessionRequest, responses: { 200: ActionAckSchema } }),
  endNativeSession: route({ method: "post", path: "/sessions/end", operationId: "endNativeSession", body: NativeSessionRequest, responses: { 200: ActionAckSchema } }),
  archiveSessionLegacy: route({ method: "post", path: "/sessions/{sessionId}/archive", operationId: "archiveSessionLegacy", params: z.object({ "sessionId": z.string() }), responses: { 200: ActionAckSchema } }),
  getStatus: route({ method: "get", path: "/status", operationId: "getStatus", responses: { 200: StatusResponse } }),
};

export const sessionsComponents = {
  BackfillSessionRequest,
  SessionIdsResponse: SessionIdsResponseSchema, SessionListingResponse: SessionListingResponseSchema,
  GuaranteeRequest, GuaranteesResponse,
  ActionAck: ActionAckSchema,
  ActionResponse: ActionResponseSchema,
  AttachRendererRequest: AttachRendererRequestSchema,
  CompactSessionRequest: CompactSessionRequest,
  CreateSessionRequest: CreateSessionRequestSchema,
  CreateSessionResponse: CreateSessionResponseSchema,
  DetachRendererRequest: DetachRendererRequestSchema,
  MessageDetailResponse: MessageDetailResponseSchema,
  MessageListResponse: MessageListResponseSchema,
  ModelCatalogResponse: ModelCatalogResponseSchema,
  NativeSessionRequest: NativeSessionRequest,
  PersistMessageRequest: PersistMessageRequestSchema,
  RendererAttachment: RendererAttachmentSchema,
  ResolvedToolsResponse: ResolvedToolsResponseSchema,
  SearchResponse: SearchResponseSchema,
  SendMessageRequest: SendMessageRequestSchema,
  SendMessageResponse: SendMessageResponseSchema,
  Session: SessionSchema,
  SessionChangeSummaryResponse: SessionChangeSummaryResponse,
  SessionContextResponse: SessionContextResponse,
  SessionListResponse: SessionListResponseSchema,
  SessionTranscriptResponse: SessionTranscriptResponse,
  SessionWorktreeResponse: SessionWorktreeResponse,
  StatusResponse: StatusResponse,
  UpdateSessionRequest: UpdateSessionRequestSchema,
};
