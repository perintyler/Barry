/**
 * The terminal as a renderer of a hosted session: what a typed line does,
 * what is printed as the session runs, and what Ctrl-C means.
 */
import { describe, expect, it } from "vitest";
import { runHostedTerminal, type HostedSessionApi, type SessionUpdate } from "./hosted-terminal.js";

/** Updates the test pushes, as the API's socket would deliver them. */
function stream() {
  const queued: SessionUpdate[] = [];
  let wake: (() => void) | null = null;
  const updates: AsyncIterable<SessionUpdate> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queued.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
  const push = (...items: SessionUpdate[]) => {
    queued.push(...items);
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  return { updates, push };
}

/** Lines the user will type, handed out one read at a time; null once they run out. */
function typed(lines: string[]) {
  const pending = [...lines];
  let release: (() => void) | null = null;
  return {
    read: async () => {
      if (pending.length === 0) return null;
      // Each line waits to be let through, so a test decides when the next is typed.
      await new Promise<void>((resolve) => (release = resolve));
      return pending.shift() ?? null;
    },
    type: () => {
      const resolve = release;
      release = null;
      resolve?.();
    },
  };
}

function api(overrides: Partial<HostedSessionApi> = {}) {
  const sent: Array<[string, boolean]> = [];
  let interrupts = 0;
  const impl: HostedSessionApi = {
    send: async (content, first) => {
      sent.push([content, first]);
      return null;
    },
    interrupt: async () => {
      interrupts++;
    },
    ...overrides,
  };
  return { impl, sent, interrupts: () => interrupts };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the hosted terminal", () => {
  it("sends each line as a turn — the first starts the session — and prints the answer once", async () => {
    const { updates, push } = stream();
    const keys = typed(["hello", "again"]);
    const out: string[] = [];
    const { impl, sent } = api();
    const terminal = runHostedTerminal({ read: keys.read, write: (text) => out.push(text) }, impl, updates);

    keys.type();
    await tick();
    push({ type: "text", role: "user", content: "hello" }, { type: "text", content: "hi there" }, { type: "result", result: "hi there" }, { type: "status", status: "waiting" });
    await tick();
    keys.type();
    await tick();
    push({ type: "tool_start", name: "Bash" }, { type: "tool_result", result: "x".repeat(250) }, { type: "result", result: "done" });
    await tick();
    keys.type();

    expect(await terminal.done).toBe(0);
    expect(sent).toEqual([["hello", true], ["again", false]]);
    expect(out).toEqual(["hi there\n", "⚡ Bash\n", `  → ${"x".repeat(200)}...\n`, "done\n"]);
  });

  it("shows a message someone sent from elsewhere, but not its own coming back", async () => {
    const { updates, push } = stream();
    const out: string[] = [];
    const terminal = runHostedTerminal({ read: async () => null, write: (text) => out.push(text) }, api().impl, updates, { prompt: "mine" });
    push({ type: "text", role: "user", content: "mine" }, { type: "text", role: "user", content: "from my phone" }, { type: "result", result: "ok" });

    expect(await terminal.done).toBe(0);
    expect(out).toEqual(["\n› (from elsewhere) from my phone\n", "ok\n"]);
  });

  it("interrupts the running turn on Ctrl-C, and has nothing to interrupt between turns", async () => {
    const { updates, push } = stream();
    const calls = api();
    const terminal = runHostedTerminal({ read: async () => null, write: () => undefined }, calls.impl, updates, { prompt: "long job", once: true });
    await tick();

    expect(await terminal.interrupt()).toBe(true);
    expect(calls.interrupts()).toBe(1);
    push({ type: "status", status: "waiting" });
    await terminal.done;
    expect(await terminal.interrupt()).toBe(false);
    expect(calls.interrupts()).toBe(1);
  });

  it("runs a one-shot as one turn, exiting non-zero when it fails", async () => {
    const { updates, push } = stream();
    const out: string[] = [];
    const terminal = runHostedTerminal({ read: async () => "never read", write: (text) => out.push(text) }, api().impl, updates, { prompt: "do it", once: true });
    push({ type: "result", error: "the harness exited" });

    expect(await terminal.done).toBe(1);
    expect(out).toEqual(["Session error: the harness exited\n"]);
  });

  it("says so, and carries on, when the API does not take a message", async () => {
    const { updates } = stream();
    const out: string[] = [];
    const terminal = runHostedTerminal(
      { read: async () => null, write: (text) => out.push(text) },
      api({ send: async () => "Session has no working directory" }).impl,
      updates,
      { prompt: "hello", once: true },
    );

    expect(await terminal.done).toBe(1);
    expect(out).toEqual(["Barry did not take that message: Session has no working directory\n"]);
  });
});

it("streams thinking and answer deltas, and does not repeat the final answer",async()=>{
 const {updates,push}=stream();const out:string[]=[];const {impl}=api();
 const terminal=runHostedTerminal({read:async()=>null,write:text=>out.push(text)},impl,updates,{prompt:"hello",once:true});
 await tick();push({type:"status",status:"starting"},{type:"thinking",content:"checking"},{type:"partial",content:"Hello"});
 await tick();expect(out.join("")).toContain("Hello");
 push({type:"partial",content:" world"},{type:"text",content:"Hello world",role:"assistant"},{type:"result",result:"Hello world"},{type:"status",status:"waiting"});
 expect(await terminal.done).toBe(0);expect(out.join("").match(/Hello world/g)).toHaveLength(1);expect(out.join("")).toContain("∴ checking");
});

it("rewrites one dim thinking line and separates the first partial exactly",async()=>{
 const {updates,push}=stream();const output:string[]=[];
 const terminal=runHostedTerminal({read:async()=>null,write:text=>output.push(text)},api().impl,updates,{prompt:"hi",once:true});
 push({type:"thinking",content:"The"},{type:"thinking",content:" user"},{type:"partial",content:"Answer"},{type:"text",content:"Answer"},{type:"status",status:"waiting"});
 expect(await terminal.done).toBe(0);
 expect(output.join("")).toBe("\r\x1b[2K\x1b[2m∴ The\x1b[0m\r\x1b[2K\x1b[2m∴ The user\x1b[0m\nAnswer\n");
});
it("a second Ctrl-C stops immediately while interrupt HTTP is still pending",async()=>{
 const {updates}=stream();let finish!:()=>void;let stops=0;
 const terminal=runHostedTerminal({read:async()=>null,write:()=>{}},api({interrupt:()=>new Promise<void>(resolve=>finish=resolve),stop:async()=>{stops++;}}).impl,updates,{prompt:"hi",once:true});
 const first=terminal.interrupt();expect(await terminal.interrupt()).toBe(true);expect(stops).toBe(1);expect(await terminal.done).toBe(130);finish();await first;
});

it("keeps exit 130 when waiting arrives before the stop HTTP response",async()=>{
 const {updates,push}=stream();let finishInterrupt!:()=>void;let finishStop!:()=>void;
 const terminal=runHostedTerminal({read:async()=>null,write:()=>{}},api({
  interrupt:()=>new Promise<void>(resolve=>finishInterrupt=resolve),
  stop:()=>new Promise<void>(resolve=>finishStop=resolve),
 }).impl,updates,{prompt:"hi",once:true});
 const first=terminal.interrupt();const second=terminal.interrupt();await tick();
 let exited=false;void terminal.done.then(()=>{exited=true;});
 push({type:"status",status:"waiting"});await tick();expect(exited).toBe(false);
 finishStop();await second;expect(await terminal.done).toBe(130);finishInterrupt();await first;
});
