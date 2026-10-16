import { describe, expect, it, vi } from "vitest";
import type { PermissionDecision, PermissionRequest, SessionConfig, SessionEvent } from "@barry-rocks/sdk/sessions";
import { PI_HOSTED } from "../modes.js";
import { PiHostedSession, type AgentSessionLike } from "./sdk-session.js";

/**
 * Creates a fake of the Pi SDK AgentSession surface.
 */
function createFakeAgentSession(options?: {
  onPrompt?: (text: string, emit: (ev: unknown) => void) => Promise<void>;
  onSteer?: (text: string, emit: (ev: unknown) => void) => Promise<void>;
  onAbort?: () => Promise<void>;
}) {
  const listeners: Array<(event: unknown) => void> = [];
  let isPromptRunning = false;

  const emit = (event: unknown) => {
    for (const l of listeners) l(event);
  };

  const fake: AgentSessionLike = {
    sessionId: "fake-pi-session-123",
    subscribe(fn: (event: unknown) => void) {
      listeners.push(fn);
      return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    async prompt(text: string) {
      isPromptRunning = true;
      try {
        if (options?.onPrompt) {
          await options.onPrompt(text, emit);
        } else {
          // Default plain turn
          emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "Answer" },
          });
          emit({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Answer" }],
              usage: { input: 10, output: 5, totalTokens: 15 },
            },
          });
        }
      } finally {
        isPromptRunning = false;
      }
    },
    async steer(text: string) {
      if (options?.onSteer) {
        await options.onSteer(text, emit);
      } else {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: " Steered" },
        });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: " Steered" }],
            usage: { input: 5, output: 2, totalTokens: 7 },
          },
        });
      }
      return "queued";
    },
    async abort() {
      if (options?.onAbort) {
        await options.onAbort();
      }
    },
    dispose() {
      listeners.length = 0;
    },
  };

  return { fake, emit, isRunning: () => isPromptRunning };
}

async function collectEvents(session: PiHostedSession, count: number): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const ev of session.events()) {
    events.push(ev);
    if (events.length >= count) break;
  }
  return events;
}

describe("PiHostedSession (in-process SDK guarantees)", () => {
  const baseConfig: SessionConfig = {
    sessionId: "test-barry-session",
    cwd: "/tmp",
    model: "anthropic/claude-sonnet-5",
    env: { ANTHROPIC_API_KEY: "sk-test" },
    mcpServers: {},
  };

  it("plain turn ends with exactly one done after result carrying usage", async () => {
    const { fake } = createFakeAgentSession();
    const session = new PiHostedSession(baseConfig, {
      guarantees: PI_HOSTED.guarantees,
      createSession: async () => fake,
    });

    const receipt = await session.deliver("What is 2+2?");
    expect(receipt.status).toBe("started");

    const events: SessionEvent[] = [];
    for await (const ev of session.events()) {
      events.push(ev);
      if (ev.type === "done") break;
    }

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0]).toMatchObject({
      type: "done",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    await session.close();
  });

  it("tool-calling turn ends with exactly one done after tool result and usage", async () => {
    const { fake } = createFakeAgentSession({
      onPrompt: async (_text, emit) => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "read",
                arguments: { path: "README.md" },
              },
            ],
          },
        });
        emit({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: "mcp__probe__read",
          args: { path: "README.md" },
        });
        emit({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: "mcp__probe__read",
          result: { content: "Sample README content" },
        });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Read complete." }],
            usage: { input: 50, output: 20, totalTokens: 70 },
          },
        });
      },
    });

    const session = new PiHostedSession(baseConfig, {
      guarantees: PI_HOSTED.guarantees,
      createSession: async () => fake,
    });

    await session.deliver("Read README");
    const events: SessionEvent[] = [];
    for await (const ev of session.events()) {
      events.push(ev);
      if (ev.type === "done") break;
    }

    expect(events.some((e) => e.type === "tool_use")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0]).toMatchObject({
      type: "done",
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
    });

    await session.close();
  });

  it("interrupted turn ends with exactly one done", async () => {
    let unblockPrompt: () => void = () => {};
    const promptDeferred = new Promise<void>((resolve) => {
      unblockPrompt = resolve;
    });

    const { fake } = createFakeAgentSession({
      onPrompt: async () => {
        await promptDeferred;
      },
      onAbort: async () => {
        unblockPrompt();
      },
    });

    const session = new PiHostedSession(baseConfig, {
      guarantees: PI_HOSTED.guarantees,
      createSession: async () => fake,
    });

    await session.deliver("Start long task");
    expect(session.status()).toBe("active");

    await session.interrupt();

    const events: SessionEvent[] = [];
    for await (const ev of session.events()) {
      events.push(ev);
      if (ev.type === "done") break;
    }

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);
    expect(session.status()).toBe("idle");

    await session.close();
  });

  it("a message steered into a running turn is answered in it, ending once", async () => {
    let finishTurn: () => void = () => {};
    const turnDeferred = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });

    const { fake } = createFakeAgentSession({
      onPrompt: async (_text, emit) => {
        emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Initial" },
        });
        await turnDeferred;
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Finished" }],
            usage: { input: 20, output: 10, totalTokens: 30 },
          },
        });
      },
    });

    const session = new PiHostedSession(baseConfig, {
      guarantees: PI_HOSTED.guarantees,
      createSession: async () => fake,
    });

    await session.deliver("Initial question");
    expect(session.status()).toBe("active");

    const steerReceipt = await session.deliver("Actually steer this", { ifActive: "steer" });
    expect(steerReceipt.status).toBe("steered");

    finishTurn();

    const events: SessionEvent[] = [];
    for await (const ev of session.events()) {
      events.push(ev);
      if (ev.type === "done") break;
    }

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0]).toMatchObject({
      type: "done",
      usage: { inputTokens: 25, outputTokens: 12, totalTokens: 37 },
    });

    await session.close();
  });

  it("puts every tool call to session ruling and refuses when denied", async () => {
    const decide = vi.fn(async (req: PermissionRequest): Promise<PermissionDecision> => {
      if (req.tool === "mcp__probe__blocked") {
        return { allow: false, reason: "Shell commands forbidden by policy" };
      }
      return { allow: true };
    });

    const configWithGating: SessionConfig = {
      ...baseConfig,
      decide,
    };

    const { createPiToolGate } = await import("./tool-gate.js");
    let gatingHandler: (event: { toolCallId: string; toolName: string; input?: Record<string, unknown>; parentToolCallId?: string }) => Promise<unknown>;
    await createPiToolGate({ ...configWithGating, mcpServers: { probe: { command: "probe" } } })({
      on: (_name: string, handler: typeof gatingHandler) => { gatingHandler = handler; },
    } as never);

    // Allowed tool call
    const allowResult = await gatingHandler!({
      toolName: "mcp__probe__read",
      toolCallId: "call-read-1",
      input: { path: "foo.txt" },
    });
    expect(allowResult).toBeUndefined();

    // Denied tool call
    const denyResult = await gatingHandler!({
      toolName: "mcp__probe__blocked",
      toolCallId: "call-bash-1",
      input: { command: "rm -rf /" },
    });
    expect(denyResult).toEqual({
      block: true,
      reason: "Shell commands forbidden by policy",
    });

    // Nested tool call with parentToolCallId
    const nestedResult = await gatingHandler!({
      toolName: "mcp__probe__blocked",
      toolCallId: "call-nested-bash",
      parentToolCallId: "call-parent-script",
      input: { command: "whoami" },
    });
    expect(nestedResult).toEqual({
      block: true,
      reason: "Shell commands forbidden by policy",
    });

    // Failing decide throws and vetoes execution
    decide.mockRejectedValueOnce(new Error("RPC failed to policy service"));
    const failResult = await gatingHandler!({
      toolName: "mcp__probe__read",
      toolCallId: "call-read-2",
      input: { path: "secret.txt" },
    });
    expect(failResult).toEqual({
      block: true,
      reason: "RPC failed to policy service",
    });
  });
});


describe("Pi shutdown", () => {
  it("awaits extension teardown before disposing SDK listeners", async () => {
    const { fake } = createFakeAgentSession();
    const calls: string[] = [];
    Object.assign(fake, { extensionRunner: { emit: async (event: unknown) => {
      expect(event).toEqual({ type: "session_shutdown", reason: "quit" });
      calls.push("shutdown");
    } }, dispose: () => calls.push("dispose") });
    const session = new PiHostedSession({ sessionId: "cleanup", cwd: "/tmp", env: {}, mcpServers: {} }, { guarantees: PI_HOSTED.guarantees, createSession: async () => fake });
    await session.init();
    await session.close();
    await session.close();
    expect(calls).toEqual(["shutdown", "dispose"]);
  });
});

describe("Pi with routed endpoint", () => {
  it("registers custom provider and endpoint without requiring vault credentials", async () => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const mr = await ModelRuntime.create({ modelsPath: null });
    mr.registerProvider("llamacpp", {
      baseUrl: "http://127.0.0.1:8080/v1",
      api: "openai-completions",
      models: [
        {
          id: "default",
          name: "default",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4096,
        },
      ],
    });
    const model = mr.getModel("llamacpp", "default");
    expect(model).toBeDefined();
    expect(model?.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(model?.api).toBe("openai-completions");
  }, 15000);

  it("records UsageEvidenceV1 through usageSink/usageReconcilePort and redacts secrets on prompt failure", async () => {
    const { DEFAULT_PI_IMPLEMENTATION_VERSION, createDefaultExecutionBinding } = await import("../inference-bounds.js");
    const { createInMemoryUsageSink } = await import("../inference-usage.js");
    const { createInMemoryUsageReconcilePort } = await import("../inference-reconciliation.js");
    const sink = createInMemoryUsageSink();
    const reconcilePort = createInMemoryUsageReconcilePort();
    const faults: unknown[] = [];

    const { fake } = createFakeAgentSession({
      onPrompt: async (_text, emit) => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Partial before error" }],
            usage: { input: 33 }, // partial usage (missing output)
          },
        });
        throw new Error("429 Rate limit for key sk-ant-api03-SECRET999888");
      },
    });

    const session = new PiHostedSession(
      {
        sessionId: "hosted-inference-test",
        cwd: "/tmp",
        model: "anthropic/claude-sonnet-5",
        env: { ANTHROPIC_API_KEY: "sk-test" },
        mcpServers: {},
      },
      {
        guarantees: PI_HOSTED.guarantees,
        createSession: async () => fake,
        inferencePolicy: {
          version: 1,
          binding: createDefaultExecutionBinding(),
          session_id: "hosted-inference-test",
          turn_id: "turn-hosted-1",
          segment_id: "seg-hosted-1",
          accepted_profile_digest: "d".repeat(64),
          endpoint_ref: "endpoint://anthropic",
          provider_protocol: "anthropic-messages",
          implementation_version: DEFAULT_PI_IMPLEMENTATION_VERSION,
          model: "claude-sonnet-5",
          deadline: 4_102_444_800_000,
          max_calls: null,
          max_input_tokens: null,
          max_output_tokens: 512,
          max_cost: null,
          fallback_policy: "none",
          accounting_policy: "reconciled",
        },
        usageSink: sink,
        usageReconcilePort: reconcilePort,
        onFault: (f) => {
          faults.push(f);
        },
      },
    );

    await session.deliver("Trigger partial usage then error");
    const events: SessionEvent[] = [];
    for await (const ev of session.events()) {
      events.push(ev);
      if (ev.type === "done") break;
    }

    // Partial usage is recorded in sink and reconcilePort, not fabricated as 0 in done.usage
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.evidence).toMatchObject({
      status: "partial",
      input_tokens: 33,
      output_tokens: null,
    });
    const doneEv = events.find((e) => e.type === "done");
    expect(doneEv).toMatchObject({ type: "done" });
    expect((doneEv as { usage?: unknown }).usage).toBeUndefined();

    // Error event must have redacted the secret API key
    const errorEv = events.find((e) => e.type === "error") as { error?: string } | undefined;
    expect(errorEv?.error).toBeDefined();
    expect(errorEv?.error).not.toContain("sk-ant-api03-SECRET999888");
    expect(faults).toHaveLength(1);

    await session.close();
  });
});

import {describeSessionContract} from "@barry-rocks/sdk/testing";
describeSessionContract("Pi SDK",()=>{
 let complete:()=>void=()=>{};let disposed=false;
 const {fake}=createFakeAgentSession({onPrompt:async(_text,emit)=>{await new Promise<void>(resolve=>{complete=()=>{emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"answer"}]}});resolve();};});}});
 const dispose=fake.dispose;fake.dispose=()=>{disposed=true;dispose();};
 const session=new PiHostedSession({sessionId:"contract",cwd:"/tmp",env:{},mcpServers:{}},{guarantees:PI_HOSTED.guarantees,createSession:async()=>fake});
 return {session,ready:async()=>{await vi.waitFor(()=>expect(session.status()).toBe("active"));},complete:async()=>{complete();await Promise.resolve();},resourcesReleased:()=>disposed};
},{describe,it});

