import { join } from "node:path";
import { createHash } from "node:crypto";
import { stableNodePath, writePrivateFile } from "@barry-rocks/sdk/services";

/** Codex whitelists environment names; this launcher restores each server's original keys. */
export function stdioEnvironment(
  name: string,
  values: Record<string, string>,
  environment: Record<string, string>,
  home: string,
): { command: string; args: string[]; env_vars: string[] } {
  const segment = Buffer.from(name).toString("hex").toUpperCase();
  const mapping = Object.entries(values).map(([key, value]): [string, string] => {
    const ref = `BARRY_CODEX_MCP_STDIO_${segment}_${Buffer.from(key).toString("hex").toUpperCase()}`;
    environment[ref] = value;
    return [key, ref];
  });
  const path = join(home, `barry-mcp-env-${createHash("sha256").update(name).digest("hex")}.cjs`);
  writePrivateFile(path, `"use strict";
const { spawn } = require("node:child_process");
const mapping = ${JSON.stringify(mapping)};
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("BARRY_CODEX_MCP_")) delete env[key];
for (const [key, ref] of mapping) {
  if (process.env[ref] === undefined) {
    process.stderr.write("Missing Codex MCP environment\\n");
    process.exit(1);
  }
  Object.defineProperty(env, key, { value: process.env[ref], enumerable: true, configurable: true, writable: true });
}
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { env, stdio: "inherit", shell: false });
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
const handlers = signals.map(signal => () => forward(signal));
signals.forEach((signal, index) => process.on(signal, handlers[index]));
child.on("error", () => { process.stderr.write("Cannot launch Codex MCP server\\n"); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  signals.forEach((name, index) => process.removeListener(name, handlers[index]));
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
`);
  return { command: stableNodePath(), args: [path], env_vars: mapping.map(([, ref]) => ref) };
}
