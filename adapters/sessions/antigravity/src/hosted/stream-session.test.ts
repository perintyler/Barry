import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ANTIGRAVITY_HOSTED } from "../modes.js";
import { AntigravityStreamSession } from "./stream-session.js";

function createFakeProcess() {
  const proc = Object.assign(new ChildProcess(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
  });
  proc.kill = vi.fn((sig?: NodeJS.Signals | number) => {
    Object.defineProperty(proc, "killed", { value: true });
    proc.emit("exit", 0, sig);
    return true;
  });
  return proc;
}

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(),
  };
});

const { spawn } = await import("node:child_process");

describe("AntigravityStreamSession", () => {
  it("delivers messages and processes stream events", async () => {
    const fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc);

    const session = new AntigravityStreamSession(
      {
        sessionId: "sess-stream",
        cwd: "/repos/app",
        env: { GEMINI_API_KEY: "test-gemini-key" },
        mcpServers: {},
      },
      { guarantees: ANTIGRAVITY_HOSTED.guarantees },
    );

    const receivedEvents: unknown[] = [];
    const eventPromise = (async () => {
      for await (const ev of session.events()) {
        receivedEvents.push(ev);
        if (ev.type === "done") break;
      }
    })();

    const receipt = await session.deliver("What is 2+2?");
    expect(receipt.status).toBe("started");
    expect(session.status()).toBe("active");

    // Simulate agy output lines
    fakeProc.stdout.write(
      JSON.stringify({
        event: "init",
        conversation_id: "conv-live-1",
        init: { cwd: "/repos/app" },
      }) + "\n",
    );

    fakeProc.stdout.write(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "ACTIVE",
          text_delta: "4",
        },
      }) + "\n",
    );

    fakeProc.stdout.write(
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "4",
          num_turns: 1,
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        },
      }) + "\n",
    );

    await eventPromise;

    expect(session.harnessSessionId).toBe("conv-live-1");
    expect(receivedEvents).toEqual([
      { type: "init", harnessSessionId: "conv-live-1" },
      { type: "partial", text: "4" },
      { type: "result", result: "4" },
      {
        type: "done",
        turns: 1,
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      },
    ]);

    await session.close();
  });

  it("handles interrupt during an active turn", async () => {
    const fakeProc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(fakeProc);

    const session = new AntigravityStreamSession(
      {
        sessionId: "sess-interrupt",
        cwd: "/repos/app",
        env: { GEMINI_API_KEY: "test-gemini-key" },
        mcpServers: {},
      },
      { guarantees: ANTIGRAVITY_HOSTED.guarantees },
    );

    await session.deliver("Long computation");
    expect(session.status()).toBe("active");

    await session.interrupt();
    expect(fakeProc.kill).toHaveBeenCalledWith("SIGINT");
    expect(session.status()).toBe("idle");

    await session.close();
  });
});
it("two objects keep one home and never inherit ambient keys", async () => {
  const config = { sessionId: "shared-home", cwd: "/tmp", env: { GEMINI_API_KEY: "selected", SELECTED: "yes" }, mcpServers: {} };
  const homes: string[] = [];
  vi.stubEnv("GEMINI_API_KEY", "ambient-gemini");
  vi.stubEnv("GOOGLE_API_KEY", "ambient-google");
  vi.stubEnv("OPENAI_API_KEY", "ambient-openai");
  try {
    for (let index = 0; index < 2; index++) {
      vi.mocked(spawn).mockReturnValue(createFakeProcess());
      const session = new AntigravityStreamSession(config, { guarantees: ANTIGRAVITY_HOSTED.guarantees });
      await session.deliver("hello");
      const options = vi.mocked(spawn).mock.calls.at(-1)?.[2];
      expect(options?.env).toEqual({ ...config.env, HOME: expect.any(String), AGY_CLI_DISABLE_AUTO_UPDATE: "true", ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) });
      homes.push(String(options?.env?.HOME));
      await expect(session.answer({ id: "call", tool: "shell", input: {} }, { allow: true })).rejects.toMatchObject({ name: "NotSupportedInMode" });
      await session.close();
    }
    expect(homes[0]).toBe(homes[1]);
  } finally { vi.unstubAllEnvs(); }
});

it("never forwards raw policy overrides from a direct hosted constructor", async () => {
  const fake = createFakeProcess();
  vi.mocked(spawn).mockReturnValue(fake);
  const session = new AntigravityStreamSession({
    sessionId: "raw-policy-override", cwd: "/tmp", env: { GEMINI_API_KEY: "synthetic-key" },
    mcpServers: {}, extraArgs: ["--fixture-raw-policy-override"],
  }, { guarantees: ANTIGRAVITY_HOSTED.guarantees });
  try {
    await session.deliver("fixture");
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).not.toContain("--fixture-raw-policy-override");
  } finally { await session.close(); }
});

import {describeSessionContract} from "@barry-rocks/sdk/testing";
describeSessionContract("Antigravity stream",()=>{
 const processes:ReturnType<typeof createFakeProcess>[]=[];
 vi.mocked(spawn).mockImplementation(()=>{const p=createFakeProcess();processes.push(p);return p;});
 const session=new AntigravityStreamSession({sessionId:"contract",cwd:"/tmp",env:{GEMINI_API_KEY:"test"},mcpServers:{}},{guarantees:ANTIGRAVITY_HOSTED.guarantees});
 return {session,ready:async()=>{await vi.waitFor(()=>expect(session.status()).toBe("active"));},complete:()=>{processes.at(-1)?.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"answer",num_turns:1}})+"\n");},resourcesReleased:()=>processes.every(p=>p.killed)};
},{describe,it});
