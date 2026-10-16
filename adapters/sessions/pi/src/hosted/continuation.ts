import { createHash } from "node:crypto";
import { runToolCall, Agent, type AgentMessage, type AgentContext } from "@earendil-works/pi-agent-core";
import { getCurrentTools, getToolStateChanges, normalizeContext, toToolDeclaration, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  ContinuationDescriptor, ContinuationEffects, ContinuationHarness,
  PermissionDecision, RecordedCallResult, SegmentOutcome, SessionEvent,
} from "@barry-rocks/sdk/sessions";
import { VERIFIED_ON } from "../modes.js";
import { piEventOf } from "../event-mapping.js";
import {
  type AdmissionCertaintyV1,
  type InferenceFaultV1,
  type RequestPhaseV1,
  classifyInferenceFault,
  redactSensitiveText,
} from "../inference-fault.js";
import {
  type EvaluatedInferencePolicyV1,
  InferencePolicyViolationError,
  authorizeExecutionAccessOnline,
  createDefaultExecutionBinding,
  evaluateInferencePolicyPreSend,
} from "../inference-bounds.js";
import {
  type ReducedUsageOutcomeV1,
  UsageAccountingCoordinator,
} from "../inference-reconciliation.js";
import {
  type UsageEvidenceV1,
  ProviderStreamUsageTracker,
  buildUsageEvidence,
  toLegacyTokenUsage,
} from "../inference-usage.js";
import type { PiInferenceRuntimeOptions } from "./sdk-session.js";

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
  private callSequence = 0;
  private issuedCalls = 0;
  private latestFault: InferenceFaultV1 | null = null;
  private readonly recordedEvidence: UsageEvidenceV1[] = [];
  private readonly accountingCoordinator: UsageAccountingCoordinator;
  private latestModelCallId: string | null = null;

  static fromSession(
    session: import("@earendil-works/pi-coding-agent").AgentSession,
    fingerprint: string,
    sessionId: string,
    inferenceOptions?: PiInferenceRuntimeOptions,
  ): PiContinuation {
    const source = session.agent;
    const policy = inferenceOptions?.inferencePolicy;
    // AgentSession's prepareRequest reloads its own SessionManager projection.
    // A separate Agent keeps Barry's restored transcript authoritative while
    // retaining Pi's scoped tools, provider transport and permission hooks.
    const agent = new Agent({
      initialState: {
        model: source.state.model,
        thinkingLevel: source.state.thinkingLevel,
        tools: source.state.tools,
        messages: source.state.messages,
      },
      streamFn: source.streamFunction,
      convertToLlm: source.convertToLlm,
      transformContext: source.transformContext,
      getApiKey: source.getApiKey,
      beforeToolCall: source.beforeToolCall,
      afterToolCall: source.afterToolCall,
      onPayload: source.onPayload,
      onResponse: source.onResponse,
      onProviderStreamEvent: source.onProviderStreamEvent,
      thinkingBudgets: source.thinkingBudgets,
      transport: source.transport,
      maxRetryDelayMs: policy ? 1 : source.maxRetryDelayMs,
      sessionId,
    });
    return new PiContinuation(
      agent,
      fingerprint,
      () => session.dispose(),
      inferenceOptions,
    );
  }

  constructor(
    private readonly agent: Agent,
    private readonly fingerprint: string,
    private readonly dispose: () => void,
    private readonly inferenceOptions?: PiInferenceRuntimeOptions,
  ) {
    this.accountingCoordinator = new UsageAccountingCoordinator({
      sink: inferenceOptions?.usageSink,
      reconcilePort: inferenceOptions?.usageReconcilePort,
      policy: inferenceOptions?.inferencePolicy ?? null,
    });
  }

  get lastFault(): InferenceFaultV1 | null {
    return this.latestFault;
  }

  get usageEvidence(): readonly UsageEvidenceV1[] {
    return this.recordedEvidence;
  }

  get issuedCallCount(): number {
    return this.issuedCalls;
  }

  getReconciledUsage(modelCallId?: string): ReducedUsageOutcomeV1 | null {
    const targetId = modelCallId ?? this.latestModelCallId;
    if (!targetId) return null;
    return this.accountingCoordinator.getReducedCall(targetId);
  }

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
    const policy = this.inferenceOptions?.inferencePolicy;
    const callIndex = ++this.callSequence;
    const modelCallId = this.inferenceOptions?.modelCallId
      ? callIndex === 1
        ? this.inferenceOptions.modelCallId
        : `${this.inferenceOptions.modelCallId}:${callIndex}`
      : policy
        ? `${policy.segment_id}:call-${callIndex}`
        : `call-${callIndex}`;
    this.latestModelCallId = modelCallId;

    let requestPhase: RequestPhaseV1 = "pre_send";
    let terminalUsageRecorded = false;
    let admissionCertainty: AdmissionCertaintyV1 = "not_sent";
    let observedHttpStatus: number | null = null;
    let observedHttpHeaders: Headers | Record<string, string> | null = null;
    let evaluatedPolicy: EvaluatedInferencePolicyV1 | undefined;

    const recordFault = async (fault: InferenceFaultV1): Promise<InferenceFaultV1> => {
      this.latestFault = fault;
      await this.inferenceOptions?.onFault?.(fault);
      return fault;
    };

    try {
      if (policy) {
        evaluatedPolicy = evaluateInferencePolicyPreSend({
          policy,
          capabilities: this.inferenceOptions?.providerCapabilities,
          endpoint: {
            protocol: policy.provider_protocol,
            model: this.matchesPolicyModel(agent.state.model, policy.model)
              ? policy.model
              : agent.state.model.id,
          },
          access: this.inferenceOptions?.executionAccess,
          callIndex,
          allowAuthorizedCostEstimate:
            this.inferenceOptions?.allowAuthorizedCostEstimate,
        });
        if (this.inferenceOptions?.executionAccess) {
          await authorizeExecutionAccessOnline(
            policy,
            this.inferenceOptions.executionAccess,
          );
        }
      }
    } catch (err) {
      const fault = await recordFault(
        classifyInferenceFault({
          error: err,
          requestPhase: "pre_send",
          admissionCertainty: "not_sent",
        }),
      );
      return { type: "failed", error: fault.public_message };
    }

    const callController = new AbortController();
    let deadlineTriggered = false;
    let deadlineTimer: NodeJS.Timeout | null = null;

    const onParentAbort = () => callController.abort();
    const accessSignal = this.inferenceOptions?.executionAccess?.signal;
    if (this.controller.signal.aborted || accessSignal?.aborted) {
      callController.abort();
    } else {
      this.controller.signal.addEventListener("abort", onParentAbort, { once: true });
      accessSignal?.addEventListener("abort", onParentAbort, { once: true });
    }

    if (evaluatedPolicy) {
      deadlineTimer = setTimeout(() => {
        deadlineTriggered = true;
        callController.abort();
      }, Math.max(1, evaluatedPolicy.remainingTimeoutMs));
      deadlineTimer.unref?.();
    }

    const signal = callController.signal;
    const protocol =
      policy?.provider_protocol ??
      (agent.state.model.api === "anthropic-messages"
        ? "anthropic-messages"
        : "openai-completions");
    const usageTracker = new ProviderStreamUsageTracker({
      protocol,
      priceSchedule: policy?.price_schedule ?? null,
    });

    const recordTerminalUsage = async (options: {
      assistant?: AssistantMessage;
      aborted: boolean;
      streamFailed: boolean;
    }) => {
      terminalUsageRecorded = true;
      const finalSnapshot = usageTracker.finalize({
        assistantMessage: options.assistant,
        aborted: options.aborted,
        streamFailed: options.streamFailed,
      });
      if (
        policy ||
        this.inferenceOptions?.usageSink ||
        this.inferenceOptions?.usageReconcilePort
      ) {
        requestPhase = "post_usage_before_ack";
        const binding = policy?.binding ?? createDefaultExecutionBinding();
        const sessionId = policy?.session_id ?? agent.sessionId ?? "session";
        const turnId = policy?.turn_id ?? "turn";
        const segmentId = policy?.segment_id ?? "segment";
        const isFinalKnown =
          finalSnapshot.status === "known" &&
          !options.streamFailed &&
          !options.aborted;
        const evidence = buildUsageEvidence({
          binding,
          session_id: sessionId,
          turn_id: turnId,
          segment_id: segmentId,
          model_call_id: modelCallId,
          sequence: 1,
          observation_kind: isFinalKnown ? "final" : "snapshot",
          provider_response_id:
            usageTracker.responseId ?? options.assistant?.responseId ?? null,
          snapshot: finalSnapshot,
          final: isFinalKnown,
        });
        this.recordedEvidence.push(evidence);
        await this.accountingCoordinator.recordAndReconcile(evidence, {
          reconcileNow: true,
        });
      }
      return finalSnapshot;
    };

    try {
      let context: AgentContext = { messages: agent.state.messages, tools: agent.state.tools };
      const prepared = await agent.prepareRequest?.({ context, model: agent.state.model, thinkingLevel: agent.state.thinkingLevel }, signal);
      if (prepared?.context) context = prepared.context;
      const model = prepared?.model ?? agent.state.model;

      if (policy && !this.matchesPolicyModel(model, policy.model)) {
        throw new InferencePolicyViolationError(
          "fallback_prohibited",
          `Model changed from "${policy.model}" to "${model.id}" under fallback_policy="none"`,
        );
      }

      if (policy) {
        evaluatedPolicy = evaluateInferencePolicyPreSend({
          policy,
          capabilities: this.inferenceOptions?.providerCapabilities,
          endpoint: {
            protocol: policy.provider_protocol,
            model: policy.model,
          },
          access: this.inferenceOptions?.executionAccess,
          callIndex,
          allowAuthorizedCostEstimate:
            this.inferenceOptions?.allowAuthorizedCostEstimate,
        });
        if (this.inferenceOptions?.executionAccess) {
          await authorizeExecutionAccessOnline(
            policy,
            this.inferenceOptions.executionAccess,
          );
        }
      }

      const changes = getToolStateChanges(getCurrentTools(context.messages), (context.tools ?? []).map(toToolDeclaration));
      if (changes.toolsAdded.length || changes.toolsRemoved.length) {
        context.messages = [...context.messages, { role: "system", content: "", timestamp: Date.now(), ...changes }];
      }
      const transformed = agent.transformContext ? await agent.transformContext(context.messages, signal) : context.messages;
      const llmMessages = await agent.convertToLlm(transformed);
      const apiKey = await agent.getApiKey?.(model.provider);
      const baseFetch = this.inferenceOptions?.customFetch ?? globalThis.fetch;

      const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
        requestPhase = "before_headers";
        admissionCertainty = "possibly_sent";
        const response = await baseFetch(input, init);
        observedHttpStatus = response.status;
        observedHttpHeaders = response.headers;
        requestPhase = "after_headers";
        admissionCertainty = "acknowledged";
        return response;
      };

      const wrappedOnPayload = async (payload: unknown, m: typeof model) => {
        const next = await agent.onPayload?.(payload, m);
        const effective = next !== undefined ? next : payload;
        if (
          evaluatedPolicy &&
          evaluatedPolicy.wireMaxOutputTokens !== null &&
          effective &&
          typeof effective === "object" &&
          !Array.isArray(effective)
        ) {
          const record = effective as Record<string, unknown>;
          if (evaluatedPolicy.wireField === "max_completion_tokens") {
            record.max_completion_tokens = evaluatedPolicy.wireMaxOutputTokens;
            delete record.max_tokens;
          } else {
            record.max_tokens = evaluatedPolicy.wireMaxOutputTokens;
          }
          if (
            record.thinking &&
            typeof record.thinking === "object" &&
            !Array.isArray(record.thinking)
          ) {
            const thinkingObj = record.thinking as Record<string, unknown>;
            if (
              typeof thinkingObj.budget_tokens === "number" &&
              thinkingObj.budget_tokens >= evaluatedPolicy.wireMaxOutputTokens
            ) {
              thinkingObj.budget_tokens = Math.max(
                0,
                evaluatedPolicy.wireMaxOutputTokens - 1,
              );
            }
          }
        }
        requestPhase = "before_headers";
        admissionCertainty = "possibly_sent";
        return effective;
      };

      const wrappedOnResponse = async (
        res: { status: number; headers: Record<string, string> },
        m: typeof model,
      ) => {
        observedHttpStatus = res.status;
        observedHttpHeaders = res.headers;
        requestPhase = "after_headers";
        admissionCertainty = "acknowledged";
        await agent.onResponse?.(res, m);
      };

      const wrappedOnProviderStreamEvent = async (
        data: unknown,
        m: typeof model,
      ) => {
        requestPhase = "midstream";
        admissionCertainty = "acknowledged";
        usageTracker.observeStreamEvent(data);
        await agent.onProviderStreamEvent?.(data, m);
      };

      this.issuedCalls += 1;
      requestPhase = "before_headers";
      admissionCertainty = "possibly_sent";

      const stream = await agent.streamFunction(
        model,
        normalizeContext({ messages: llmMessages }),
        {
          signal,
          apiKey,
          ...(evaluatedPolicy?.wireMaxOutputTokens !== null &&
          evaluatedPolicy?.wireMaxOutputTokens !== undefined
            ? { maxTokens: evaluatedPolicy.wireMaxOutputTokens }
            : {}),
          ...(policy
            ? {
                maxRetries: 0,
                maxRetryDelayMs: 1,
                timeoutMs: evaluatedPolicy?.remainingTimeoutMs,
              }
            : {}),
          fetch: wrappedFetch,
          reasoning:
            (prepared?.thinkingLevel ?? agent.state.thinkingLevel) === "off"
              ? undefined
              : ((prepared?.thinkingLevel ?? agent.state.thinkingLevel) as Exclude<
                  Agent["state"]["thinkingLevel"],
                  "off"
                >),
          sessionId: agent.sessionId,
          transport: agent.transport,
          onPayload: wrappedOnPayload,
          onResponse: wrappedOnResponse,
          onProviderStreamEvent: wrappedOnProviderStreamEvent,
        },
      );

      let streamedText = "";
      for await (const event of stream) {
        if (event.type !== "error") {
          requestPhase = "midstream";
          admissionCertainty = "acknowledged";
        }
        if (event.type === "text_delta") {
          streamedText += event.delta;
          await emit({ type: "partial", text: event.delta });
        }
      }

      const assistant = await stream.result();
      const streamFailed =
        assistant.stopReason === "error" || assistant.stopReason === "aborted";
      const abortedByCaller = signal.aborted && !deadlineTriggered;

      const faultPhaseBeforeUsage: RequestPhaseV1 =
        observedHttpStatus !== null && observedHttpStatus >= 400
          ? "after_headers"
          : usageTracker.hasObservedStreamEvents
            ? "midstream"
            : requestPhase;

      const finalSnapshot = await recordTerminalUsage({
        assistant,
        aborted: abortedByCaller,
        streamFailed,
      });

      const legacyUsage = toLegacyTokenUsage(finalSnapshot) ??
        (!streamFailed && !usageTracker.hasObservedStreamEvents
          ? piEventOf({ type: "message_end", message: assistant }).usage
          : undefined);
      if (legacyUsage) {
        await emit({
          type: "usage",
          id:
            usageTracker.responseId ??
            assistant.responseId ??
            createHash("sha256").update(JSON.stringify(assistant)).digest("hex"),
          usage: legacyUsage,
        });
      }

      const text = assistant.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (!text.startsWith(streamedText)) {
        return {
          type: "failed",
          error: "Pi final text differs from the published stream",
        };
      }
      if (text.length > streamedText.length) {
        await emit({ type: "partial", text: text.slice(streamedText.length) });
      }
      agent.state.messages = [...context.messages, assistant];

      if (streamFailed) {
        const fault = await recordFault(
          classifyInferenceFault({
            errorMessage: assistant.errorMessage ?? assistant.stopReason,
            status: observedHttpStatus,
            headers: observedHttpHeaders,
            requestPhase: faultPhaseBeforeUsage,
            admissionCertainty,
            aborted: abortedByCaller,
            deadlineExpired: deadlineTriggered,
          }),
        );
        return {
          type: "failed",
          error: policy
            ? fault.public_message
            : redactSensitiveText(
                assistant.errorMessage ?? assistant.stopReason,
                apiKey ? [apiKey] : undefined,
              ),
        };
      }

      const calls = assistant.content.filter((part) => part.type === "toolCall");
      if (!calls.length) {
        return {
          type: "completed",
          result: text,
          conversation: this.checkpoint(assistant),
        };
      }
      if (assistant.stopReason === "length") {
        return { type: "failed", error: "Pi tool arguments were truncated" };
      }
      for (const call of calls) {
        await emit({
          type: "tool_use",
          id: call.id,
          tool: call.name,
          input: call.arguments,
        });
      }
      return {
        type: "interrupted",
        calls: calls.map((call) => ({
          id: call.id,
          tool: call.name,
          input: call.arguments,
        })),
        continuation: this.checkpoint(assistant),
      };
    } catch (err) {
      if (
        !(err instanceof InferencePolicyViolationError) &&
        requestPhase !== "pre_send" &&
        !terminalUsageRecorded
      ) {
        try {
          await recordTerminalUsage({
            aborted: signal.aborted && !deadlineTriggered,
            streamFailed: true,
          });
        } catch {
          // Preserve primary fault when usage fallback also fails
        }
      }
      const fault = await recordFault(
        classifyInferenceFault({
          error: err,
          status: observedHttpStatus,
          headers: observedHttpHeaders,
          requestPhase,
          admissionCertainty,
          aborted: signal.aborted && !deadlineTriggered,
          deadlineExpired: deadlineTriggered,
        }),
      );
      return {
        type: "failed",
        error: policy
          ? fault.public_message
          : redactSensitiveText(
              err instanceof Error ? err.message : String(err),
            ),
      };
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.controller.signal.removeEventListener("abort", onParentAbort);
      accessSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  private matchesPolicyModel(
    model: { provider?: string; id: string },
    policyModel: string,
  ): boolean {
    if (model.id === policyModel) return true;
    if (model.provider && `${model.provider}/${model.id}` === policyModel) {
      return true;
    }
    return false;
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
