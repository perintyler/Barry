import { expect, it, vi } from "vitest";
import { startClaudeLive } from "./start.js";
import { CLAUDE_LIVE } from "../modes.js";
const { query, opened } = vi.hoisted(() => {
  let notify: () => void;
  const opened = new Promise<void>(resolve => { notify = resolve; });
  const query = vi.fn((..._args: unknown[]) => {
    notify();
    return { async *[Symbol.asyncIterator]() {}, close() {}, async interrupt() {} };
  });
  return { query, opened };
});
const warmSdk = vi.hoisted(() => ({ enabled: true, startup: vi.fn(async (input: { options: Record<string, unknown> }) => ({ query: (prompt: unknown) => query({ prompt, options: input.options }), close() {} })) }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query, get startup() { return warmSdk.enabled ? warmSdk.startup : undefined; } }));
it("opens with the shared hook and its timeout, without canUseTool", async () => {
  const session = startClaudeLive({ sessionId: "test", cwd: "/tmp", env: {}, mcpServers: {} }, { guarantees: CLAUDE_LIVE.guarantees, rulingWindow: 3 });
  await session.deliver("hello");
  await opened;
  expect(query).toHaveBeenCalled();
  expect(warmSdk.startup).toHaveBeenCalledWith(expect.objectContaining({ initializeTimeoutMs: 120_000 }));
  const options = query.mock.calls[0][0] as { options: Record<string, unknown> };
  expect(options.options).not.toHaveProperty("canUseTool");
  expect(options.options.hooks).toMatchObject({ PreToolUse: [{ timeout: 3, hooks: [expect.any(Function)] }] });
  await session.close();
});

it("uses startup and waits for initialization before a warm query", async () => {
  warmSdk.enabled = true;
  warmSdk.startup.mockClear();
  const session = startClaudeLive({ sessionId: "warm-test", cwd: "/tmp", env: {}, mcpServers: {} }, { guarantees: CLAUDE_LIVE.guarantees });
  await session.warm?.();
  expect(warmSdk.startup).toHaveBeenCalledWith(expect.objectContaining({ initializeTimeoutMs: 60_000 }));
  await session.close();
});
it("falls back to query for an SDK without startup", async () => {
  warmSdk.enabled = false;
  query.mockClear();
  const session = startClaudeLive({ sessionId: "legacy-test", cwd: "/tmp", env: {}, mcpServers: {} }, { guarantees: CLAUDE_LIVE.guarantees });
  await session.warm?.();
  expect(query).toHaveBeenCalledWith(expect.objectContaining({ options: expect.any(Object) }));
  await session.close();
  warmSdk.enabled = true;
});

it("aborts a failed initialized spawn so warm cannot leave a subprocess linked", async()=>{
  warmSdk.enabled=true;
  let controller:AbortController|undefined;
  warmSdk.startup.mockImplementationOnce(async input=>{controller=input.options.abortController as AbortController;throw Error("initialization timed out");});
  const session=startClaudeLive({sessionId:"failed-warm",cwd:"/tmp",env:{},mcpServers:{}},{guarantees:CLAUDE_LIVE.guarantees});
  await expect(session.warm?.()).rejects.toThrow("initialization timed out");
  expect(controller?.signal.aborted).toBe(true);expect(session.isWarm?.()).toBe(false);
  await session.close();
});

it("close aborts startup before a silent initialization can finish",async()=>{
 warmSdk.enabled=true;let controller:AbortController|undefined;
 warmSdk.startup.mockImplementationOnce(input=>new Promise((_resolve,reject)=>{controller=input.options.abortController as AbortController;controller.signal.addEventListener("abort",()=>reject(Error("closed during startup")),{once:true});}));
 const session=startClaudeLive({sessionId:"stop-startup",cwd:"/tmp",env:{},mcpServers:{}},{guarantees:CLAUDE_LIVE.guarantees});
 const warming=session.warm!();const outcome=expect(warming).rejects.toThrow();
 await vi.waitFor(()=>expect(controller).toBeDefined());await session.close();expect(controller!.signal.aborted).toBe(true);await outcome;expect(session.isWarm!()).toBe(false);
});
