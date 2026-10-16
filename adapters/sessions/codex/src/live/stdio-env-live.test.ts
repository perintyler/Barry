import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { prepareCodexRuntime } from "../runtime.js";
import { CODEX_REQUIREMENTS } from "../modes.js";

describe.runIf(process.env.BARRY_CODEX_LIVE === "1")("Codex stdio configuration, live", () => {
  it("loads private environment references through the pinned vendor and completes MCP initialization", async () => {
    expect(execFileSync("codex", ["--version"], { encoding: "utf8" })).toContain(process.env.BARRY_CODEX_LIVE_VERSION ?? CODEX_REQUIREMENTS.binary.recommendedVersion!);
    const root = mkdtempSync(join(tmpdir(), "cx-stdio-live-"));
    const marker = join(root, "observed.json");
    const fixture = join(root, "server.cjs");
    let child: ChildProcess | undefined;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let id = 0;
    try {
      writeFileSync(fixture, String.raw`
const fs = require("node:fs");
fs.writeFileSync(process.argv[2], JSON.stringify({
  secret: process.env.API_KEY,
  prefixed: Object.keys(process.env).filter(key => key.startsWith("BARRY_CODEX_MCP_"))
}), { mode: 0o600 });
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize") result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "stdio-env-fixture", version: "1" }
  };
  if (request.method === "tools/list") result = { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
`, { mode: 0o600 });
      const runtime = prepareCodexRuntime({
        codexHome: join(root, "cx"), projectDir: root, model: "openai/gpt-test",
        endpoint: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "synthetic-provider-key" },
        env: { PATH: process.env.PATH, HOME: root },
        mcpServers: { local: { command: process.execPath, args: [fixture, marker], env: { API_KEY: "synthetic-stdio-secret" } } },
      });
      // No model turn: even background provider lookups target a closed loopback port.
      child = spawn("codex", ["app-server"], { cwd: root, env: runtime.env, stdio: ["pipe", "pipe", "ignore"] });
      if (!child.stdout || !child.stdin) throw new Error("Missing app-server pipes");
      const input = child.stdin;
      createInterface({ input: child.stdout }).on("line", line => {
        const reply = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (reply.id === undefined) return;
        const waiter = pending.get(reply.id);
        if (!waiter) return;
        pending.delete(reply.id);
        if (reply.error) waiter.reject(new Error(reply.error.message));
        else waiter.resolve(reply.result);
      });
      child.on("error", error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
      child.on("exit", () => { for (const waiter of pending.values()) waiter.reject(new Error("App-server exited")); pending.clear(); });
      const call = (method: string, params: unknown): Promise<unknown> => {
        const requestId = ++id;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timed out: ${method}`)); }, 10_000);
          pending.set(requestId, {
            resolve: value => { clearTimeout(timeout); resolve(value); },
            reject: error => { clearTimeout(timeout); reject(error); },
          });
          input.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
        });
      };
      await call("initialize", { clientInfo: { name: "barry-stdio-test", version: "1" }, capabilities: { experimentalApi: true } });
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
      await call("thread/start", { cwd: root, approvalPolicy: "never", sandbox: "danger-full-access", model: "gpt-test", modelProvider: "barry-endpoint-openai" });
      const deadline = Date.now() + 10_000;
      let ready = false;
      while (!ready && Date.now() < deadline) {
        const status = await call("mcpServerStatus/list", {}) as { data: Array<{ name: string; serverInfo?: { name: string }; toolsError?: string | null }> };
        const local = status.data.find(server => server.name === "local");
        ready = local?.serverInfo?.name === "stdio-env-fixture" && local.toolsError == null;
        if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(ready).toBe(true);
      expect(existsSync(marker)).toBe(true);
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ secret: "synthetic-stdio-secret", prefixed: [] });
      expect(readFileSync(runtime.configPath, "utf8")).not.toContain("synthetic-stdio-secret");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise<void>(resolve => child?.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await stopped;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
