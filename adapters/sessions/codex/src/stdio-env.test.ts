import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexMcpServersToToml, prepareCodexRuntime } from "./runtime.js";

describe("Codex stdio environment indirection", () => {
  it("keeps values out of generated files while preserving per-server keys, stdio and exit status", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-stdio-"));
    try {
      const probe = "let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({value:process.env.API_KEY,input,prefixed:Object.keys(process.env).filter(k=>k.startsWith('BARRY_CODEX_MCP_'))}));process.stderr.write('probe-error');process.exitCode=23;});";
      const servers = Object.fromEntries(["a-b", "a_b"].map((name, index) => [name, { command: process.execPath, args: ["-e", probe], env: { API_KEY: `fixture-secret-${index}` } }]));
      const runtime = prepareCodexRuntime({ codexHome: home, env: {}, mcpServers: servers });
      const config = readFileSync(runtime.configPath, "utf8");
      expect(config).not.toContain("fixture-secret-");
      expect(config).toContain("env_vars = [");
      for (const file of readdirSync(home).filter(name => name.endsWith(".cjs"))) {
        expect(readFileSync(join(home, file), "utf8")).not.toContain("fixture-secret-");
        expect(statSync(join(home, file)).mode & 0o777).toBe(0o600);
      }
      const translated = codexMcpServersToToml(servers, {}, home);
      const refs = Object.values(translated).flatMap(server => server.env_vars ?? []);
      expect(new Set(refs).size).toBe(2);
      for (const [index, name] of ["a-b", "a_b"].entries()) {
        const server = translated[name];
        if (!server) throw new Error("Missing fixture server");
        const result = spawnSync(server.command!, server.args, { env: runtime.env, input: "stdio fixture", encoding: "utf8", timeout: 5000 });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(23);
        expect(result.stderr).toBe("probe-error");
        expect(JSON.parse(String(result.stdout))).toEqual({ value: `fixture-secret-${index}`, input: "stdio fixture", prefixed: [] });
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("forwards termination to the running child and preserves its handled exit", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-stdio-"));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const env: Record<string, string> = {};
      const translated = codexMcpServersToToml({ local: { command: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{process.stdout.write('terminated');process.exit(23)});process.stdout.write('ready');setInterval(()=>{},1000);"], env: { API_KEY: "fixture-secret" } } }, env, home);
      const server = translated.local;
      if (!server) throw new Error("Missing fixture server");
      child = spawn(server.command!, server.args, { env, stdio: ["pipe", "pipe", "pipe"] });
      expect(String((await once(child.stdout!, "data"))[0])).toBe("ready");
      const exited = once(child, "exit");
      const output = once(child.stdout!, "data");
      child.kill("SIGTERM");
      expect(String((await output)[0])).toBe("terminated");
      expect(await exited).toEqual([23, null]);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses missing forwarded secrets before launching the child", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-stdio-"));
    try {
      const translated = codexMcpServersToToml({ local: { command: process.execPath, args: ["-e", "process.stdout.write('CHILD_STARTED')"], env: { API_KEY: "fixture-secret" } } }, {}, home);
      const server = translated.local;
      if (!server) throw new Error("Missing fixture server");
      const result = spawnSync(server.command!, server.args, { env: {}, encoding: "utf8", timeout: 5000 });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Missing Codex MCP environment");
      expect(result.stderr).not.toContain("fixture-secret");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
