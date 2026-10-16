/**
 * Sessions as the API serves them: the session and message records, the
 * requests that create, update and message a session, and the responses
 * around them. The sessions bag maps its rows to these; clients validate
 * against the same schemas.
 *
 * Not exported from `@barry-rocks/sdk/sessions`, whose `Session` is the
 * in-process session handle; this module's `Session` is the record, which the
 * package root exports.
 */
import { z } from "zod";
import { HarnessIdSchema } from "../ids.js";
import { ReviewRulesSchema } from "./continuations.js";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const SessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  systemPrompt: z.string().nullable(),
  summary: z.string().nullable(),
  repoPath: z.string().nullable(),
  /** The git branch the session works on. */
  branch: z.string().nullable().optional(),
  /** Where the agent's transcript is recorded. */
  transcriptPath: z.string().nullable().optional(),
  /** The machine running the agent. */
  hostname: z.string().nullable().optional(),
  /** The OS process running the agent, reported by the CLI after it spawns the child. */
  pid: z.int().nullable().optional(),
  /** Process start time in unix seconds (`ps -o lstart=`). */
  pidStartedAt: z.int().nullable().optional(),
  identityId: z.int().nullable(),
  identitySource: z.enum(["explicit", "repo", "default", "file"]).nullable(),
  status: z.enum(["pending", "planning", "running", "completed", "failed", "cancelled"]),
  bags: z.array(z.string()).optional(),
  bounds: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
  bound: z.record(z.string(), z.unknown()).nullable(),
  pinned: z.boolean(),
  useWorktree: z.boolean(),
  worktreeStatus: z.string().nullable(),
  worktreePath: z.string().nullable(),
  baseRepoPath: z.string().nullable(),
  source: z.string().nullable(),
  /**
   * The harness by the id clients have always read — a renamed harness's
   * former id (`claude` for Claude Code). Kept until clients read `harness`.
   */
  provider: HarnessIdSchema.nullable(),
  /**
   * The harness by its id now (`claude-code`). Optional so a client built
   * against this contract still reads an API from before it.
   */
  harness: HarnessIdSchema.nullable().optional(),
  /** As the harness names it; `modelRef` says which vendor serves it. */
  model: z.string().nullable(),
  /** The model as `vendor/model`; null when the harness picks its own, or the vendor is unknown. */
  modelRef: z.string().nullable().optional(),
  messageCount: z.int().nonnegative().optional(),
  lastMessageAt: z.iso.datetime().nullable().optional(),
  // Derived from the session's latest `progress` event (recorded by the
  // record_event tool) — distinct from the auto-generated `summary` column,
  // which the session summarizer owns.
  statusUpdate: z.object({
    summary: z.string().nullable(),
    phase: z.string().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  }).nullable().optional(),
  lastEventAt: z.iso.datetime().nullable().optional(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable().optional(),
}).strict();

export const CreateSessionResponseSchema = z.union([
  SessionSchema,
  SessionSchema.extend({ started: z.literal(true) }),
  SessionSchema.extend({ started: z.literal(false), startError: z.string() }),
]);
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const MessageSchema = z.object({
  dedupeKey:z.string().optional(),
  type: z.enum(["text", "tool_start", "error", "init", "result", "summary"]),
  sessionId: z.string(),
  sequence: z.int().nonnegative(),
  role: z.enum(["user", "assistant", "system"]).nullable().optional(),
  content: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  input: z.unknown().nullable().optional(),
  result: z.unknown().nullable().optional(),
  hasDetail: z.boolean().optional(),
  error: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  taskStatus: z.string().nullable().optional(),
  toolUseId: z.string().nullable().optional(),
  clientMessageId: z.string().nullable().optional(),
  deliveryState: z.enum(["queued", "accepted", "failed", "uncertain"]).optional(),
  deliveryError: z.string().nullable().optional(),
  /**
   * Present when the message came from a subagent rather than the main thread,
   * carrying the id of the Task tool call that spawned it. Consumers use it to
   * nest delegated work instead of presenting it as the agent's own.
   */
  parentToolUseId: z.string().nullable().optional(),
  lastEventAt: z.iso.datetime().nullable().optional(),
  createdAt: z.iso.datetime(),
}).strict();

/**
 * Create a session.
 *
 * Replaces `CreateDraftSessionRequestSchema`. There is no "draft" session: the
 * concept named one thing (a row that exists but has no agent running yet) as
 * though it were a kind of session, and the only way to create a session through
 * this API was to create a "draft" and then start it.
 *
 * `prompt` is what collapses the two steps. Supply it and the session is created
 * AND started in one call. Omit it and you get the inert row — which is still a
 * real need, not a leftover: `POST /actions/trigger` returns a session id plus
 * the prompt text WITHOUT sending it, so the caller can subscribe to the
 * session's socket before the agent produces any output. Starting eagerly there
 * would lose the first tokens.
 */
export const CreateSessionRequestSchema = z.object({
  systemPrompt: z.string().min(1).max(200_000),
  /**
   * Send this as the session's first message, starting the agent.
   *
   * Omitted: the row is created and nothing runs, and the caller starts it with
   * `POST /sessions/{id}/message` when it is ready to receive output.
   */
  prompt: z.string().min(1).max(200_000).optional(),
  repoPath: z.string().max(4096).optional(),
  name: z.string().max(100).optional(),
  bags: z.array(z.string()).optional(),
  identityId: z.int().nullable().optional(),
  useWorktree: z.boolean().optional(),
  provider: HarnessIdSchema.optional(),
  model: z.string().optional(),
  /**
   * Model provider (e.g. "ollama") to route the model to. Explicit because a
   * custom model id names no provider on its own.
   */
  modelProvider: z.string().min(1).optional(),
  /** Approval behavior for future turns in this session. Defaults to review-required. */
  reviewPolicy: ReviewRulesSchema.optional(),
  reviewRules: ReviewRulesSchema.optional(),
  /** Named or inline bounds from `identity.yaml` or bag manifests. */
  bounds: z.array(z.union([z.string().min(1), z.record(z.string(), z.unknown())])).optional(),
  /** Inline bound, for restrictions that don't warrant a named bound. */
  bound: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

// Starting a turn and choosing a worktree are not metadata updates.
export const UpdateSessionRequestSchema = CreateSessionRequestSchema.omit({ prompt: true, useWorktree: true }).partial().extend({
  prepare: z.boolean().optional(),
  metadata: z.strictObject({ effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional() }).optional(),
  // Defaults would clear existing selections on unrelated updates.
  bags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
  selectedNamespaces: z.array(z.string()).optional(),
  selectedTools: z.array(z.string()).optional(),
  /**
   * The OS process running the agent, reported by the CLI after it spawns the
   * child (the session row is created before the child exists, so this cannot
   * ride along on `/sessions/start`).
   *
   * Sent as a pair and stored as a pair: `pidStartedAt` is what distinguishes
   * the recorded process from an unrelated one that later inherits the same
   * pid. Both are nullable so the CLI can clear them when the child exits.
   */
  pid: z.int().nullable().optional(),
  /** Process start time in unix seconds (`ps -o lstart=`). */
  pidStartedAt: z.int().nullable().optional(),
  command: z.string().optional(),
  processName: z.string().optional(),
  appName: z.string().optional(),
  parentPid: z.int().nullable().optional(),
}).strict();

/**
 * POST /sessions/:id/messages/persist — used by agent hooks.
 *
 * Three shapes share this endpoint, so common fields are optional and the
 * handler enforces what each `type` requires:
 *   text        — role + content
 *   tool_call   — name (+ optional input/result/toolUseId)
 *   tool_result — result + toolUseId, backfilling an earlier tool_call
 */
export const PersistMessageRequestSchema = z.object({
  type: z.string(),
  role: z.enum(["user", "assistant"]).optional(),
  content: z.unknown().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  result: z.unknown().optional(),
  /** Pairs a tool_result with its tool_call. Without it, matching falls back
   *  to insertion order and an orphaned call shifts every later pairing. */
  toolUseId: z.string().optional(),
  /** Set when the call came from a subagent rather than the main thread. Hooks
   *  derive it from the PostToolUse payload's `agent_id`. This schema is strict,
   *  so without this field a hook sending it would get a 400. */
  parentToolUseId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const SendMessageRequestSchema = z.object({
  content: z.string().min(1).max(200_000),
  repoPath: z.string().max(4096).optional(),
  // Client-generated idempotency key. Retries reuse the same id.
  clientMessageId: z.string().min(1).max(256).optional(),
}).strict();

export const AttachRendererRequestSchema = z.object({
  /** The process launching the TUI: the attachment ends if it dies without detaching. */
  launcherPid: z.int().positive(),
}).strict();

export const RendererAttachmentSchema = z.object({
  attachmentId: z.string(),
  /** The engine the TUI connects to. */
  address: z.string(),
  /** The conversation the TUI resumes. */
  harnessSessionId: z.string(),
}).strict();

export const DetachRendererRequestSchema = z.object({
  attachmentId: z.string().min(1).max(256),
}).strict();

export const SendMessageResponseSchema = z.object({
  turn: z.enum(["queued", "admitted"]).optional(),
  warm: z.union([z.literal(0),z.literal(1)]).optional(),
  ok: z.boolean(),
  sessionId: z.string(),
  deliveryState: z.enum(["queued", "accepted", "failed", "uncertain"]),
  clientMessageId: z.string().nullable().optional(),
  messageId: z.string().optional(),
}).passthrough();

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionSchema),
  nextCursor: z.string().nullable(),
}).strict();

export const MessageListResponseSchema = z.object({
  /** False when the response includes rows still queued for recording. */
  durable: z.boolean().optional(),
  messages: z.array(MessageSchema),
  nextSequence: z.int().nullable(),
  hasMore: z.boolean(),
}).strict();

export const ActionResponseSchema = z.object({
  recordingPending:z.boolean().optional(),
  message: z.string().optional(),
  sessionId: z.string().nullable().optional(),
  status: z.string().optional(),
}).strict();
export const MessageDetailResponseSchema = z.object({
  input: z.unknown().nullable(),
  result: z.unknown().nullable(),
}).strict();

const ResolvedNamespaceSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  grantedBy: z.array(z.string()),
  toolCount: z.int().nonnegative(),
}).strict();
const ResolvedToolSchema = z.object({
  toolName: z.string(),
  namespace: z.string(),
  access: z.string(),
  enabled: z.boolean(),
  grantedBy: z.string().nullable(),
}).strict();
export const ResolvedToolsResponseSchema = z.object({
  bags: z.object({
    active: z.array(z.string()),
    available: z.array(z.string()).optional(),
  }).strict().optional(),
  bounds: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
  availableBounds: z.array(z.string()).optional(),
  bound: z.record(z.string(), z.unknown()).nullable().optional(),
  selectedNamespaces: z.array(z.string()),
  selectedTools: z.array(z.string()),
  namespaces: z.array(ResolvedNamespaceSchema),
  tools: z.array(ResolvedToolSchema),
}).strict();

export const SearchResponseSchema = z.object({ results: z.array(JsonObjectSchema) }).strict();

export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sessionStarted"), sessionId: z.string(), provider: HarnessIdSchema }),
  z.object({ type: z.literal("assistantDelta"), sessionId: z.string(), text: z.string() }),
  z.object({ type: z.literal("assistantMessage"), sessionId: z.string(), content: z.unknown() }),
  z.object({ type: z.literal("toolStarted"), sessionId: z.string(), toolCallId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("toolCompleted"), sessionId: z.string(), toolCallId: z.string(), result: z.unknown(), isError: z.boolean() }),
  z.object({ type: z.literal("usage"), sessionId: z.string(), inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative() }),
  z.object({ type: z.literal("error"), sessionId: z.string(), message: z.string(), recoverable: z.boolean() }),
  z.object({ type: z.literal("completed"), sessionId: z.string(), reason: z.string().optional() }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type RendererAttachment = z.infer<typeof RendererAttachmentSchema>;
