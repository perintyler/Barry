import { createHash } from "node:crypto";
import { runToolCall, Agent, type AgentMessage, type AgentContext } from "@earendil-works/pi-agent-core";
import { getCurrentTools, getToolStateChanges, normalizeContext, toToolDeclaration, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  ContinuationDescriptor, ContinuationEffects, ContinuationHarness,
  PermissionDecision, RecordedCallResult, SegmentOutcome, SessionEvent,
} from "@barry-rocks/sdk/sessions";
import { VERIFIED_ON } from "../modes.js";
import { piEventOf } from "../event-mapping.js";

interface Checkpoint {
  messages: AgentMessage[];
  assistant: AssistantMessage;
  toolSignatures: string;
}

/** Pi supplies models, tools and hooks; Barry owns the suspension boundary. */
export class PiContinuation implements ContinuationHarness {
  readonly approvalContinuation = "durable" as const;
  private controller = new AbortController();
  private closed = false;

  static fromSession(session: import("@earendil-works/pi-coding-agent").AgentSession, fingerprint: string, sessionId: string): PiContinuation {
    const source = session.agent;
    // AgentSession's prepareRequest reloads its own SessionManager projection.
    // A separate Agent keeps Barry's restored transcript authoritative while
    // retaining Pi's scoped tools, provider transport and permission hooks.
    const agent = new Agent({
      initialState: { model: source.state.model, thinkingLevel: source.state.thinkingLevel, tools: source.state.tools, messages: source.state.messages },
      streamFn: source.streamFunction, convertToLlm: source.convertToLlm,
      transformContext: source.transformContext, getApiKey: source.getApiKey,
      beforeToolCall: source.beforeToolCall, afterToolCall: source.afterToolCall,
      onPayload: source.onPayload, onResponse: source.onResponse, onProviderStreamEvent: source.onProviderStreamEvent,
      thinkingBudgets: source.thinkingBudgets, transport: source.transport, maxRetryDelayMs: source.maxRetryDelayMs,
      sessionId,
    });
    return new PiContinuation(agent, fingerprint, () => session.dispose());
  }

  constructor(
    private readonly agent: Agent,
    private readonly fingerprint: string,
    private readonly dispose: () => void,
  ) {}

  private toolSignatures(): string {
    return createHash("sha256").update(JSON.stringify(this.agent.state.tools.map(toToolDeclaration))).digest("hex");
  }

  validate(descriptor: ContinuationDescriptor): void {
    if (descriptor.format !== "barry.pi.tool-boundary" || descriptor.version !== 1
      || descriptor.adapterId !== "pi" || descriptor.adapterVersion !== "1.0.0"
      || descriptor.harnessVersion !== VERIFIED_ON || descriptor.configFingerprint !== this.fingerprint) {
      throw new Error("Incompatible Pi continuation");
    }
    const payload = descriptor.payload as Partial<Checkpoint> | null;
    if (!payload || !Array.isArray(payload.messages) || payload.assistant?.role !== "assistant"
      || !Array.isArray(payload.assistant.content) || payload.toolSignatures !== this.toolSignatures()
      || JSON.stringify(payload.messages.at(-1)) !== JSON.stringify(payload.assistant)) {
      throw new Error("Invalid Pi continuation or changed tool contracts");
    }
    const calls = payload.assistant.content.filter((part) => part.type === "toolCall");
    if (new Set(calls.map((call) => call.id)).size !== calls.length) {
      throw new Error("Invalid Pi pending call batch");
    }
  }

  async begin(content: string, emit: (event: SessionEvent) => Promise<void>, conversation?: ContinuationDescriptor): Promise<SegmentOutcome> {
    if (this.closed) throw new Error("Pi continuation is closed");
    if (conversation) {
      this.validate(conversation);
      const saved = structuredClone(conversation.payload) as Checkpoint;
      if (saved.assistant.content.some((part) => part.type === "toolCall")) throw new Error("Conversation still has pending calls");
      this.agent.state.messages = saved.messages;
    }
    this.agent.state.messages = [...this.agent.state.messages, { role: "user", content, timestamp: Date.now() }];
    return this.run(emit);
  }

  async restore(
    descriptor: ContinuationDescriptor,
    decisions: ReadonlyMap<string, PermissionDecision>,
    effects: ContinuationEffects,
    emit: (event: SessionEvent) => Promise<void>,
  ): Promise<SegmentOutcome> {
    if (this.closed) throw new Error("Pi continuation is closed");
    this.validate(descriptor);
    const saved = structuredClone(descriptor.payload) as Checkpoint;
    const calls = saved.assistant.content.filter((part) => part.type === "toolCall");
    if (!calls.length || decisions.size !== calls.length || calls.some((call) => !decisions.has(call.id))) {
      throw new Error("A Pi resume must resolve the complete pending batch");
    }
    this.agent.state.messages = saved.messages;
    const context: AgentContext = { messages: this.agent.state.messages, tools: this.agent.state.tools };
    for (const call of calls) {
      const request = { id: call.id, tool: call.name, input: call.arguments };
      const existing = await effects.recorded?.(request);
      let decision = decisions.get(call.id)!;
      if (!existing && decision.allow) decision = await effects.authorize(request);
      let recorded: RecordedCallResult;
      if (existing) recorded = existing;
      else if (!decision.allow) {
        recorded = { id: call.id, result: { content: [{ type: "text", text: decision.reason ?? "Denied by Barry policy" }] }, error: true };
        recorded = await effects.denied?.(request, recorded) ?? recorded;
      } else {
        recorded = await effects.execute(request, async () => {
          const outcome = await runToolCall(call, {
            assistantMessage: saved.assistant, context, tools: this.agent.state.tools,
            beforeToolCall: this.agent.beforeToolCall,
            afterToolCall: this.agent.afterToolCall,
            signal: this.controller.signal,
          });
          return JSON.parse(JSON.stringify({ id: call.id, result: outcome.result, error: outcome.isError })) as RecordedCallResult;
        });
      }
      const result = recorded.result as { content: ToolResultMessage["content"]; details?: ToolResultMessage["details"] };
      const message: ToolResultMessage = {
        role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: result.content, details: result.details, isError: !!recorded.error, timestamp: Date.now(),
      };
      this.agent.state.messages = [...this.agent.state.messages, message];
      context.messages = this.agent.state.messages;
      await emit({ type: "tool_result", id: call.id, result: recorded.result, error: recorded.error });
    }
    return this.run(emit);
  }

  private async run(emit: (event: SessionEvent) => Promise<void>): Promise<SegmentOutcome> {
    const agent = this.agent;
    const signal = this.controller.signal;
    let context: AgentContext = { messages: agent.state.messages, tools: agent.state.tools };
    const prepared = await agent.prepareRequest?.({ context, model: agent.state.model, thinkingLevel: agent.state.thinkingLevel }, signal);
    if (prepared?.context) context = prepared.context;
    const model = prepared?.model ?? agent.state.model;
    const changes = getToolStateChanges(getCurrentTools(context.messages), (context.tools ?? []).map(toToolDeclaration));
    if (changes.toolsAdded.length || changes.toolsRemoved.length) {
      context.messages = [...context.messages, { role: "system", content: "", timestamp: Date.now(), ...changes }];
    }
    const transformed = agent.transformContext ? await agent.transformContext(context.messages, signal) : context.messages;
    const stream = await agent.streamFunction(model, normalizeContext({ messages: await agent.convertToLlm(transformed) }), {
      signal, apiKey: await agent.getApiKey?.(model.provider),
      reasoning: (prepared?.thinkingLevel ?? agent.state.thinkingLevel) === "off" ? undefined : (prepared?.thinkingLevel ?? agent.state.thinkingLevel) as Exclude<Agent["state"]["thinkingLevel"], "off">,
      sessionId: agent.sessionId, transport: agent.transport,
      onPayload: agent.onPayload, onResponse: agent.onResponse, onProviderStreamEvent: agent.onProviderStreamEvent,
    });
    let streamedText = "";
    for await (const event of stream) {
      if (event.type === "text_delta") { streamedText += event.delta; await emit({ type: "partial", text: event.delta }); }
    }
    const assistant = await stream.result();
    const usage = piEventOf({ type: "message_end", message: assistant }).usage;
    if (usage) await emit({ type: "usage", id: assistant.responseId ?? createHash("sha256").update(JSON.stringify(assistant)).digest("hex"), usage });
    const text = assistant.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    if (!text.startsWith(streamedText)) return { type: "failed", error: "Pi final text differs from the published stream" };
    if (text.length > streamedText.length) await emit({ type: "partial", text: text.slice(streamedText.length) });
    agent.state.messages = [...context.messages, assistant];
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      return { type: "failed", error: assistant.errorMessage ?? assistant.stopReason };
    }
    const calls = assistant.content.filter((part) => part.type === "toolCall");
    if (!calls.length) {
      return { type: "completed", result: assistant.content.filter((part) => part.type === "text").map((part) => part.text).join(""), conversation: this.checkpoint(assistant) };
    }
    if (assistant.stopReason === "length") return { type: "failed", error: "Pi tool arguments were truncated" };
    for (const call of calls) await emit({ type: "tool_use", id: call.id, tool: call.name, input: call.arguments });
    return {
      type: "interrupted",
      calls: calls.map((call) => ({ id: call.id, tool: call.name, input: call.arguments })),
      continuation: this.checkpoint(assistant),
    };
  }

  private checkpoint(assistant: AssistantMessage): ContinuationDescriptor {
    return {
        format: "barry.pi.tool-boundary", version: 1, adapterId: "pi", adapterVersion: "1.0.0",
        harnessVersion: VERIFIED_ON, configFingerprint: this.fingerprint,
        payload: JSON.parse(JSON.stringify({ messages: this.agent.state.messages, assistant, toolSignatures: this.toolSignatures() })),
    };
  }

  async interrupt(): Promise<void> { this.controller.abort(); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.dispose();
  }
}
