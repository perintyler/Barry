/**
 * claude's live hosted session, as its caller sees it: what a delivery does,
 * what a turn emits, and what a tool call is asked — against a fake query
 * speaking the SDK's message shapes through the real event mapper.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@barry-rocks/sdk/sessions";
import { processSDKMessage } from "../anthropic-compatible/event-mapping.js";
import {
  ClaudeLiveSession,
  type ClaudeLiveOptions,
  type LiveQuery,
  type UserMessage,
} from "./live-session.js";

const LIVE = {
  capture: "total",
  delivery: "wake",
  steer: true,
  interrupt: true,
  gating: "per-call",
  keepsVendorUi: false,
  identity: "inherent",
} as const;

/** One process: reads the prompt it was given, and says what the test tells it to. */
class FakeProcess implements LiveQuery {
  readonly received: string[] = [];
  interrupted = 0;
  closed = false;
  private readonly outbox: unknown[] = [];
  private wake: (() => void) | null = null;
  private ended: Error | "exit" | null = null;

  constructor(
    prompt: AsyncIterable<UserMessage>,
    readonly resume: string | undefined,
  ) {
    void (async () => {
      for await (const message of prompt) {
        this.received.push(message.message.content);
        this.poke();
      }
    })();
  }

  say(...messages: unknown[]): void {
    this.outbox.push(...messages);
    this.poke();
  }

  exit(error?: Error): void {
    this.ended = error ?? "exit";
    this.poke();
  }

  async interrupt(): Promise<void> {
    this.interrupted++;
  }

  close(): void {
    this.closed = true;
    this.exit();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (;;) {
      const next = this.outbox.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended instanceof Error) throw this.ended;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private poke(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

const init = (sessionId = "conv-1") => ({ type: "system", subtype: "init", session_id: sessionId, claude_code_version: "2.1.282" });
const said = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] }, parent_tool_use_id: null });
const finished = (result: string) => ({
  type: "result",
  subtype: "success",
  result,
  usage: { input_tokens: 10, output_tokens: 2 },
});
const interruptedResult = () => ({ type: "result", subtype: "error_during_execution", errors: ["interrupted"], usage: { input_tokens: 1, output_tokens: 0 } });

function harness(overrides: Partial<ClaudeLiveOptions> = {}) {
  const processes: FakeProcess[] = [];
  const session = new ClaudeLiveSession({
    id: "sess-1",
    guarantees: LIVE,
    open: async (prompt, resume) => {
      const process = new FakeProcess(prompt, resume);
      processes.push(process);
      return process;
    },
    toEvents: (message) => processSDKMessage(message as Parameters<typeof processSDKMessage>[0]),
    structuredTurn: () => {
      throw new Error("no structured turn expected");
    },
    ...overrides,
  });
  const reader = session.events()[Symbol.asyncIterator]();
  /** Events up to and including the next `done`. */
  const turn = async (): Promise<SessionEvent[]> => {
    const events: SessionEvent[] = [];
    for (;;) {
      const next = await reader.next();
      if (next.done) return events;
      events.push(next.value);
      if (next.value.type === "done") return events;
    }
  };
  const process = async (index = 0): Promise<FakeProcess> => {
    await until(() => processes[index] !== undefined);
    const opened = processes[index];
    if (!opened) throw new Error(`no process ${index} was opened`);
    return opened;
  };
  return { session, processes, turn, process };
}

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const types = (events: SessionEvent[]) => events.map((event) => event.type);

describe("claude's live hosted session", () => {
  it("runs a turn on the live process and ends it with the answer, then one done carrying usage", async () => {
    const { session, turn, process } = harness();
    expect(await session.deliver("hello")).toMatchObject({ status: "started" });
    const live = await process();
    await until(() => live.received.length === 1);
    live.say(init(), said("hi there"), finished("hi there"));

    const events = await turn();
    expect(types(events)).toEqual(["init", "text", "result", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 10, outputTokens: 2 } });
    expect(session.harnessSessionId).toBe("conv-1");
    expect(session.harnessVersion).toBe("2.1.282");
    expect(session.status()).toBe("idle");
  });

  it("keeps one process across turns, and announces the conversation once", async () => {
    const { session, turn, process, processes } = harness();
    await session.deliver("one");
    const live = await process();
    await until(() => live.received.length === 1);
    live.say(init(), finished("1"));
    await turn();

    await session.deliver("two");
    await until(() => live.received.length === 2);
    live.say(init(), finished("2"));
    expect(types(await turn())).toEqual(["result", "done"]);
    expect(processes).toHaveLength(1);
    expect(live.received).toEqual(["one", "two"]);
  });

  it("holds a message that arrives mid-turn until the turn ends, unless it is asked to steer", async () => {
    const { session, turn, process } = harness();
    await session.deliver("first");
    const live = await process();
    await until(() => live.received.length === 1);

    expect(await session.deliver("second")).toMatchObject({ status: "queued" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(live.received).toEqual(["first"]);
    live.say(init(), finished("1"));
    await turn();
    await until(() => live.received.length === 2);
    expect(live.received).toEqual(["first", "second"]);

    expect(await session.deliver("also this", { ifActive: "steer" })).toMatchObject({ status: "steered" });
    await until(() => live.received.length === 3);
    expect(live.received.at(-1)).toBe("also this");
  });

  it("interrupts with the SDK's interrupt, which ends the turn and keeps the conversation", async () => {
    const { session, turn, process, processes } = harness();
    await session.deliver("long job");
    const live = await process();
    await until(() => live.received.length === 1);
    await session.interrupt();
    expect(live.interrupted).toBe(1);
    live.say(init(), interruptedResult());
    expect(types(await turn())).toEqual(["init", "result", "done"]);

    await session.deliver("next");
    await until(() => live.received.length === 2);
    expect(processes).toHaveLength(1);
  });

  it("rejects answer because the hook rules calls", async () => {
    const { session } = harness();
    await expect(session.answer({ id: "call", tool: "Bash", input: {} }, { allow: true })).rejects.toMatchObject({ name: "NotSupportedInMode" });
    await session.close();
  });

  it("ends a turn whose process died with an error, and resumes the conversation on the next delivery", async () => {
    const { session, turn, process } = harness();
    await session.deliver("one");
    const first = await process();
    await until(() => first.received.length === 1);
    first.say(init(), said("working"));
    first.exit(new Error("claude exited with code 1"));

    const events = await turn();
    expect(types(events)).toEqual(["init", "text", "error", "done"]);
    expect(events.find((event) => event.type === "error")).toMatchObject({ error: "claude exited with code 1" });
    expect(session.status()).toBe("error");

    await session.deliver("again");
    const second = await process(1);
    expect(second.resume).toBe("conv-1");
    await until(() => second.received.length === 1);
    expect(second.received).toEqual(["again"]);
  });

  it("lets an idle process go after the quiet spell, and the next delivery resumes the conversation", async () => {
    const { session, turn, process } = harness({ releaseAfterMs: 20 });
    await session.deliver("one");
    const first = await process();
    await until(() => first.received.length === 1);
    first.say(init(), finished("1"));
    await turn();

    await until(() => first.closed);
    await session.deliver("two");
    const second = await process(1);
    expect(second.resume).toBe("conv-1");
    await until(() => second.received.length === 1);
    second.say(init(), finished("2"));
    expect(types(await turn())).toEqual(["result", "done"]);
  });

  it("runs a turn that asks for a schema one-shot, without the live process, and hands back the payload", async () => {
    const asked: Array<{ content: string; schema: unknown }> = [];
    const { session, turn, processes } = harness({
      structuredTurn: async function* (content, schema) {
        asked.push({ content, schema });
        yield { type: "init", harnessSessionId: "one-shot-conv" };
        yield { type: "result", result: '{"n":42}', structured: { n: 42 } };
        yield { type: "done" };
      },
    });
    const schema = { type: "object", properties: { n: { type: "number" } } };
    await session.deliver("count", { outputSchema: schema });
    const events = await turn();

    expect(asked).toEqual([{ content: "count", schema }]);
    expect(events).toMatchObject([{ type: "result", structured: { n: 42 } }, { type: "done" }]);
    expect(processes).toHaveLength(0);
    expect(session.harnessSessionId).toBeNull();
  });

  it("ends the open turn for its reader when closed", async () => {
    const { session, turn, process } = harness();
    await session.deliver("do things");
    const live = await process();
    await session.close();

    expect(types(await turn())).toEqual(["done"]);
    expect(live.closed).toBe(true);
    await expect(session.deliver("more")).rejects.toThrow(/closed/);
  });
});


it("warms before delivery and reuses that process, including concurrent warm calls", async () => {
  const { session, processes } = harness();
  await Promise.all([session.warm(), session.warm()]);
  expect(processes).toHaveLength(1);
  expect(processes[0].received).toEqual([]);
  await session.deliver("hello");
  await until(() => processes[0].received.length === 1);
  expect(processes).toHaveLength(1);
  expect(processes[0].received).toEqual(["hello"]);
  await session.close();
});
it("refuses warm after closing without opening a process", async () => {
  const { session, processes } = harness();
  await session.close();
  await expect(session.warm()).rejects.toThrow("closed");
  expect(processes).toHaveLength(0);
});

it("can deliver cold after a failed warm without keeping a failed opening", async () => {
  let opens = 0;
  let process: FakeProcess | undefined;
  const { session } = harness({ open: async (prompt, resume) => {
    if (++opens === 1) throw new Error("initialize failed");
    return process = new FakeProcess(prompt, resume);
  } });
  await expect(session.warm()).rejects.toThrow("initialize failed");
  await session.deliver("hello");
  await until(() => process?.received.length === 1);
  expect(opens).toBe(2);
  await session.close();
});

it("retries initialization once before handing the prompt to a fresh process",async()=>{
 let opens=0;let live:FakeProcess|undefined;
 const {session,turn}=harness({open:async(prompt,resume)=>{if(++opens===1)throw Error("initialization timed out");live=new FakeProcess(prompt,resume);return live;}});
 await session.deliver("retry once");await until(()=>live?.received.length===1);
 live!.say(init(),finished("recovered"));const events=await turn();
 expect(opens).toBe(2);expect(events).toContainEqual({type:"status",status:"retrying"});expect(events.some(e=>e.type==="error")).toBe(false);await session.close();
});
it("ends a turn after the second initialization failure instead of retrying indefinitely",async()=>{
 let opens=0;const {session,turn}=harness({open:async()=>{opens++;throw Error("initialization timed out");}});
 await session.deliver("fail");const events=await turn();expect(opens).toBe(2);expect(types(events)).toEqual(["status","error","done"]);await session.close();
});

it("renews a warmed process lease on client activity",async()=>{
 vi.useFakeTimers();const {session,processes}=harness({releaseAfterMs:100});
 try {
  await session.warm();expect(session.isWarm()).toBe(true);
  await vi.advanceTimersByTimeAsync(90);session.touch();await vi.advanceTimersByTimeAsync(90);expect(processes[0].closed).toBe(false);
  await vi.advanceTimersByTimeAsync(11);expect(processes[0].closed).toBe(true);expect(session.isWarm()).toBe(false);
 } finally {await session.close();vi.useRealTimers();}
});

import {describeSessionContract} from "@barry-rocks/sdk/testing";
describeSessionContract("Claude live",()=>{
 const h=harness();let live:FakeProcess;
 return {session:h.session,ready:async()=>{live=await h.process();},complete:()=>{live.say(said("answer"),finished("answer"));},resourcesReleased:()=>h.processes.every(p=>p.closed)};
},{describe,it});
it("close aborts an initialization retry and cannot retry again afterward",async()=>{
 let reject!: (error:Error)=>void;let attempts=0;
 const h=harness({open:async()=>{attempts++;if(attempts===1)throw Error("Subprocess initialization did not complete");return new Promise((_resolve,no)=>{reject=no;});},abortOpen:()=>reject?.(Error("closed"))});
 await h.session.deliver("hello");await until(()=>attempts===2);await h.session.close();
 const events=await h.turn();expect(events.filter(e=>e.type==="done")).toHaveLength(1);expect(attempts).toBe(2);expect(h.session.isWarm()).toBe(false);
});
