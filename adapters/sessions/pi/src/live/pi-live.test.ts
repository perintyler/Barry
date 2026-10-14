import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import adapter from "../adapter.js";
import type { SessionEvent } from "@barry-rocks/sdk/sessions";

// BARRY_PI_LIVE=1: bundled Pi with a local OpenAI-compatible endpoint, no secrets.
it.skipIf(process.env.BARRY_PI_LIVE !== "1")("native grants allow file reads and refuse shell", async () => {
  const root = mkdtempSync(join(tmpdir(), "barry-pi-native-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "pi"));
  vi.stubEnv("BARRY_HOME", join(root, "barry"));
  const file = join(root, "fixture.txt"), sentinel = join(root, "sentinel");
  writeFileSync(file, "GRANTED_NATIVE_READ");
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", data => raw += data);
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const messages = body.messages ?? [];
      const last = messages.at(-1);
      const finished = last?.role === "tool";
      const shell = JSON.stringify(last).includes("FORCE_SHELL");
      const content = finished ? JSON.stringify(last) : undefined;
      const call = { index: 0, id: `call_${requests.length}`, type: "function", function: { name: shell ? "bash" : "read", arguments: JSON.stringify(shell ? { command: `touch ${sentinel}` } : { path: file }) } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk(finished ? { role: "assistant", content } : { role: "assistant", tool_calls: [call] }, null);
      chunk({}, finished ? "stop" : "tool_calls");
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const session = await adapter.modes.hosted!.start({ sessionId: "pi-native", cwd: root, env: { HOME: root, PATH: process.env.PATH }, model: "openai/probe", endpoint: { baseUrl: endpoint, apiKey: "local-key" }, mcpServers: {}, allowedNativeTools: ["read", "grep", "find", "ls"] }, async () => { throw Error("no engine"); });
  const turn = async (prompt: string) => {
    await session.deliver(prompt);
    const events: SessionEvent[] = [];
    for await (const event of session.events()) { events.push(event); if (event.type === "done") break; }
    return JSON.stringify(events);
  };
  try {
    expect(await turn("Read the fixture")).toContain("GRANTED_NATIVE_READ");
    expect(await turn("FORCE_SHELL")).toContain("Tool bash not found");
    expect(existsSync(sentinel)).toBe(false);
  } finally {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);
