import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { oauthHelperLaunch } from "./oauth-launch.js";

it("the pinned executable authenticates to a real remote HTTP transport using its scratch token cache", async () => {
  const home = await mkdtemp(join(tmpdir(), "mcp-oauth-helper-"));
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== "/mcp") { response.writeHead(404); response.end(); return; }
    if (request.headers.authorization !== "Bearer fixture-oauth-token") { response.writeHead(401); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(message.method);
    if (message.id === undefined) { response.writeHead(204); response.end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "scratch-remote-bag", version: "1" } }
      : { tools: [{ name: "fixture_read", description: "Read fixture", inputSchema: { type: "object" } }] } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  let child: ChildProcessWithoutNullStreams | undefined;
  let errors = "";
  try {
    const cache = join(home, ".mcp-auth", "mcp-remote-v1");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const hash = createHash("md5").update(url).digest("hex");
    await writeFile(join(cache, `${hash}_tokens.json`), JSON.stringify({ access_token: "fixture-oauth-token", token_type: "Bearer", expires_in: 3600 }), { mode: 0o600 });
    vi.stubEnv("HOME", home);
    vi.stubEnv("BARRY_HOME", join(home, "barry"));
    const { hasOAuthTokens } = await import("@barry-rocks/sdk/internal/vault");
    expect(hasOAuthTokens(url)).toBe(true);
    const { buildBag } = await import("@barry-rocks/sdk/internal/bags");
    const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const built = await buildBag({ name: "oauth-launch-fixture", bagDir: fileURLToPath(new URL("../", import.meta.url)), entry: fileURLToPath(new URL("./oauth-launch.ts", import.meta.url)), externals: metadata.barry?.build?.externals });
    expect(built.ok, built.error).toBe(true);
    // Plain Node must resolve from the built cache, without Vitest's source resolver.
    const launch = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      const { oauthHelperLaunch } = await import(process.argv[1]);
      console.log(JSON.stringify(oauthHelperLaunch(process.argv[2], { HOME: process.env.HOME, PATH: process.env.PATH, BARRY_SECRET: "must-not-inherit", NODE_OPTIONS: "must-not-inherit" })));
    `, pathToFileURL(built.outFile!).href, url], { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" })) as ReturnType<typeof oauthHelperLaunch>;
    expect(launch.env).not.toHaveProperty("BARRY_SECRET");
    expect(launch.env).not.toHaveProperty("NODE_OPTIONS");
    // HTTP is permitted only for this loopback fixture, not added to production launches.
    child = spawn(launch.command, [...launch.args, "--allow-http", "--transport", "http-only"], { env: launch.env, stdio: "pipe" });
    child.stderr.on("data", chunk => { errors += chunk.toString(); });
    let pending = "";
    const replies = new Map<number, { result?: { tools?: Array<{ name: string }> }; error?: unknown }>();
    child.stdout.on("data", chunk => {
      pending += chunk.toString(); const lines = pending.split("\n"); pending = lines.pop()!;
      for (const line of lines) if (line.trim()) { const message = JSON.parse(line); if (message.id !== undefined) replies.set(message.id, message); }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "barry-test", version: "1" } } }) + "\n");
    await vi.waitFor(() => expect(replies.has(1), errors).toBe(true), { timeout: 15_000 });
    expect(replies.get(1)?.error).toBeUndefined();
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
    await vi.waitFor(() => expect(replies.get(2)?.result?.tools, errors).toEqual([expect.objectContaining({ name: "fixture_read" })]), { timeout: 15_000 });
    expect(methods).toContain("initialize"); expect(methods).toContain("tools/list");
  } finally {
    vi.unstubAllEnvs();
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
