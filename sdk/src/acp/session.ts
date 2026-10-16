/**
 * A hosted session over the Agent Client Protocol, with Barry as the client.
 *
 * Follows the spec where the code this replaces did not: a permission is
 * answered on the SAME request id with an option the harness offered, a turn
 * ends when the `session/prompt` RESPONSE arrives, cancel is a notification,
 * and only one prompt runs at a time — a second concurrent prompt cancels the
 * first on some harnesses, so messages arriving mid-turn wait and go together.
 */
import {
  client,
  methods,
  PROTOCOL_VERSION,
  type ClientApp,
  type ClientConnection,
  type McpServer,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Guarantees } from "../adapters/harnesses/index.js";
import { EventQueue } from "../sessions/event-queue.js";
import type {
  DeliveryReceipt,
  McpServerConfig,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionConfig,
  SessionEvent,
} from "../sessions/index.js";
import type { TokenUsage } from "../adapters/models/kinds.js";

export interface AcpSessionOptions {
  config: SessionConfig;
  guarantees: Guarantees;
  /** Opens the connection; the transport (a child's stdio, or a test's agent) is the caller's. */
  connect(app: ClientApp): ClientConnection;
  /** Sent only when the harness also advertises it. */
  authMethod?: string;
  /** Continue this conversation with `session/load` instead of starting one. */
  resume?: string;
  /** Release the transport once the connection is closed. */
  release?(): Promise<void> | void;
  /** See {@link AcpToolIdentity}. Without it a call is known by its title. */
  identifyTool?(call: AcpToolCall): AcpToolIdentity | undefined;
}

/** What a harness has said about one tool call so far, across its updates. */
export interface AcpToolCall {
  toolCallId?: string;
  title?: string | null;
  kind?: string | null;
  rawInput?: unknown;
}

/**
 * A tool call as Barry's policy knows it. Harnesses title calls for display,
 * and a title is not a name a denial list or a server scope can match.
 */
export interface AcpToolIdentity {
  name: string;
  input: unknown;
}

const REJECT_KINDS = ["reject_once", "reject_always"] as const;

export async function openAcpSession(options: AcpSessionOptions): Promise<Session> {
  const { config } = options;
  const events = new EventQueue<SessionEvent>();
  const queued: string[] = [];
  const openPermissions = new Map<
    string,
    { offered: readonly PermissionOption[]; respond(response: RequestPermissionResponse): void }
  >();
  let status: "idle" | "active" | "error" = "idle";
  let acpSessionId = "";
  let loading = false;
  let closed = false;
  let messageCount = 0;
  let turnNumber=0;
  let permissionCount = 0;
  let turnText = "";
  let turnCost: number | undefined;
  let turnEnded: Promise<void> = Promise.resolve();
  /** What is known of each call still running, for naming it when it asks permission. */
  const calls = new Map<string, AcpToolCall>();
  /** Calls already reported as `tool_use`: a call's name may arrive after it starts. */
  const announced = new Set<string>();

  const app = client({ name: "barry" })
    .onNotification(methods.client.session.update, ({ params }) => onUpdate(params))
    .onRequest(methods.client.session.requestPermission, ({ params }) => onPermission(params));
  const connection = options.connect(app);
  const agent = connection.agent;

  function onUpdate(notification: SessionNotification): void {
    // History replayed by `session/load` is already Barry's record of the
    // conversation; emitting it again would store every message twice.
    if (loading || notification.sessionId !== acpSessionId) return;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          turnText += update.content.text;
          events.push({ type: "partial", text: update.content.text });
        }
        return;
      case "user_message_chunk":
        if (update.content.type === "text") events.push({ type: "text", text: update.content.text, role: "user" });
        return;
      case "tool_call":
        if (!options.identifyTool) {
          events.push({ type: "tool_use", id: update.toolCallId, tool: update.title, input: update.rawInput ?? {} });
          return;
        }
        heard(update.toolCallId, update);
        announceOnceNamed(update.toolCallId);
        return;
      case "tool_call_update":
        if (options.identifyTool) {
          heard(update.toolCallId, update);
          // A call that has started is announced named or not: its result must
          // follow its use.
          if (update.status) announce(update.toolCallId);
          else announceOnceNamed(update.toolCallId);
        }
        if (update.status === "completed" || update.status === "failed") {
          events.push({
            type: "tool_result",
            id: update.toolCallId,
            result: update.rawOutput ?? update.content ?? null,
            ...(update.status === "failed" ? { error: true } : {}),
          });
          calls.delete(update.toolCallId);
          announced.delete(update.toolCallId);
        }
        return;
      case "usage_update":
        if (update.cost?.currency === "USD") turnCost = update.cost.amount;
        return;
      default:
        // Thoughts, plans, mode and command lists: nothing Barry records.
        return;
    }
  }

  /** Folds what an update says of a call into what is already known of it. */
  function heard(id: string, said: AcpToolCall): AcpToolCall {
    const known = calls.get(id) ?? {};
    const merged = {
      toolCallId: said.toolCallId ?? known.toolCallId ?? id,
      title: said.title ?? known.title,
      kind: said.kind ?? known.kind,
      rawInput: said.rawInput ?? known.rawInput,
    };
    calls.set(id, merged);
    return merged;
  }

  function identityOf(call: AcpToolCall): AcpToolIdentity {
    return options.identifyTool?.(call) ?? { name: call.title ?? call.kind ?? "tool", input: call.rawInput ?? {} };
  }

  function announceOnceNamed(id: string): void {
    const call = calls.get(id);
    if (call && options.identifyTool?.(call)) announce(id);
  }

  function announce(id: string): void {
    if (announced.has(id)) return;
    announced.add(id);
    const { name, input } = identityOf(calls.get(id) ?? {});
    events.push({ type: "tool_use", id, tool: name, input });
  }

  function onPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const call = options.identifyTool ? heard(params.toolCall.toolCallId, params.toolCall) : params.toolCall;
    if (options.identifyTool) announce(params.toolCall.toolCallId);
    const { name, input } = identityOf(call);
    const request: PermissionRequest = {
      id: `${params.toolCall.toolCallId}#${++permissionCount}`,
      tool: name,
      input,
    };
    events.push({ type: "permission_request", id: request.id, tool: request.tool, input: request.input });

    return new Promise((resolve) => {
      openPermissions.set(request.id, {
        offered: params.options,
        respond(response) {
          openPermissions.delete(request.id);
          resolve(response);
        },
      });
      // Every request is answered, on every path: an unanswered one blocks the
      // tool forever and the session looks hung rather than refused.
      const decided = config.decide
        ? config.decide(request).catch((): PermissionDecision => ({ allow: false, reason: "the decision failed" }))
        : Promise.resolve<PermissionDecision>({ allow: false, reason: "nothing decides for this session" });
      void decided.then((decision) => openPermissions.get(request.id)?.respond(choose(params.options, decision)));
    });
  }

  function startTurn(content: string): void {
    turnNumber++;
    status = "active";
    turnText = "";
    turnCost = undefined;
    events.push({ type: "status", status: "active" });
    turnEnded = agent
      .request(methods.agent.session.prompt, { sessionId: acpSessionId, prompt: [{ type: "text", text: content }] })
      .then(endTurn, failTurn);
  }

  function endTurn(response: PromptResponse): void {
    if(closed || status!=="active")return;
    if (turnText) events.push({ type: "text", text: turnText, role: "assistant" });
    status = "idle";
    events.push({ type: "status", status: "idle" });
    events.push({
      type: "result",
      ...(turnText ? { result: turnText } : {}),
      ...(response.stopReason === "end_turn" ? {} : { error: `turn ended: ${response.stopReason}` }),
    });
    const usage = usageOf(response, turnCost);
    events.push({ type: "done", ...(usage ? { usage } : {}) });
    sendQueued();
  }

  function failTurn(err: unknown): void {
    if(closed || status!=="active")return;
    status = "error";
    events.push({ type: "error", error: err instanceof Error ? err.message : String(err) });
    events.push({ type: "done" });
    if (!closed) sendQueued();
  }

  // Joined into one prompt: three messages sent one at a time would make the
  // agent answer three times when it was asked three things at once.
  function sendQueued(): void {
    if (closed || queued.length === 0) return;
    startTurn(queued.splice(0).join("\n\n"));
  }

  function cancelOpenPermissions(): void {
    for (const pending of [...openPermissions.values()]) pending.respond({ outcome: { outcome: "cancelled" } });
  }

  let harnessVersion: string | null = null;
  try {
    const init = await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "barry", version: "1" },
    });
    harnessVersion = init.agentInfo?.version ?? null;
    const capabilities = init.agentCapabilities ?? {};

    if (options.authMethod && init.authMethods?.some((method) => method.id === options.authMethod)) {
      await agent.request(methods.agent.authenticate, { methodId: options.authMethod });
    }

    const mcpServers = toAcpServers(config.mcpServers, capabilities.mcpCapabilities ?? {});
    const additionalDirectories =
      config.projectRoots?.length && capabilities.sessionCapabilities?.additionalDirectories
        ? { additionalDirectories: config.projectRoots }
        : {};

    if (options.resume) {
      if (!capabilities.loadSession) {
        throw new Error("this harness cannot resume a conversation over ACP (no loadSession)");
      }
      acpSessionId = options.resume;
      loading = true;
      await agent.request(methods.agent.session.load, {
        sessionId: options.resume,
        cwd: config.cwd,
        mcpServers,
        ...additionalDirectories,
      });
      loading = false;
    } else {
      const created = await agent.request(methods.agent.session.new, {
        cwd: config.cwd,
        mcpServers,
        ...additionalDirectories,
      });
      acpSessionId = created.sessionId;
    }
  } catch (err) {
    connection.close();
    await options.release?.();
    throw err;
  }

  events.push({ type: "init", harnessSessionId: acpSessionId });

  void connection.closed.then(() => {
    if (closed) return;
    const wasActive=status==="active";
    closed = true;
    status = "error";
    cancelOpenPermissions();
    events.push({ type: "error", error: "the harness closed the connection" });
    if(wasActive)events.push({type:"done"});
    events.end();
  });

  return {
    id: config.sessionId,
    harnessSessionId: acpSessionId,
    harnessVersion,
    mode: "hosted",
    guarantees: { ...options.guarantees },

    events: () => events,

    async deliver(content): Promise<DeliveryReceipt> {
      if (closed) throw new Error(`session ${config.sessionId} is closed`);
      const messageId = `${config.sessionId}-msg-${++messageCount}`;
      if (status === "active") {
        queued.push(content);
        return { messageId, status: "queued" };
      }
      startTurn(content);
      return { messageId, status: "started" };
    },

    async interrupt(): Promise<void> {
      if (status !== "active") return;
      const number=turnNumber;const ended=turnEnded;
      await agent.notify(methods.agent.session.cancel, { sessionId: acpSessionId });
      // The spec has the client answer anything still pending as cancelled;
      // the harness then ends the turn with stopReason "cancelled".
      if(number===turnNumber)cancelOpenPermissions();
      await ended;
    },

    async answer(request, decision): Promise<void> {
      const pending = openPermissions.get(request.id);
      // Already answered — by `decide`, or by cancel. A late answer is expected traffic.
      if (!pending) return;
      pending.respond(choose(pending.offered, decision));
    },

    status: () => status,

    async close(): Promise<void> {
      if (closed) return;
      if(status==="active")events.push({type:"done"});
      status="idle";closed = true;
      queued.length = 0;
      cancelOpenPermissions();
      events.end();
      connection.close();
      await options.release?.();
    },
  };
}

/**
 * Pick an option the harness offered, by its kind — never by a guessed id.
 * With nothing matching, the request is answered as cancelled rather than
 * with an option the harness never offered.
 *
 * The protocol SDK does not validate responses on the harness side (measured
 * against 1.5.0: a flattened outcome arrived as the string "selected"), so the
 * shape here is guarded only by its type and `acp.test.ts`.
 */
function choose(offered: readonly PermissionOption[], decision: PermissionDecision): RequestPermissionResponse {
  const preference: readonly string[] = decision.allow
    ? decision.persist
      ? ["allow_always", "allow_once"]
      : ["allow_once", "allow_always"]
    : REJECT_KINDS;
  for (const kind of preference) {
    const option = offered.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function toAcpServers(
  servers: Record<string, McpServerConfig>,
  supported: { http?: boolean; sse?: boolean },
): McpServer[] {
  // Servers the harness cannot take over ACP are left to its own config file,
  // which the adapter's launch writes; sending one it did not advertise would
  // fail the whole `session/new`.
  const out: McpServer[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if ("command" in server) {
      const env = Object.entries(server.env ?? {}).map(([variable, value]) => ({ name: variable, value }));
      out.push({ name, command: server.command, args: server.args ?? [], env });
    } else if (supported[server.type]) {
      const headers = Object.entries(server.headers ?? {}).map(([header, value]) => ({ name: header, value }));
      out.push({ type: server.type, name, url: server.url, headers });
    }
  }
  return out;
}

function usageOf(response: PromptResponse, costUsd: number | undefined): TokenUsage | undefined {
  const usage = response.usage;
  if (!usage && costUsd === undefined) return undefined;
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    ...(usage ? { totalTokens: usage.totalTokens } : {}),
    ...(usage?.cachedReadTokens != null ? { cacheReadTokens: usage.cachedReadTokens } : {}),
    ...(usage?.cachedWriteTokens != null ? { cacheWriteTokens: usage.cachedWriteTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}
