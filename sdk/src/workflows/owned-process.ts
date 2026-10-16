/** Trusted composition primitive, not an authority or public arbitrary-command API. */
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin, createRequire } from "node:module";
import { processBootIdentity } from "./work-process-supervisor.js";
import { guardianDescendantsAbsent, type EscapedDescendantIdentity } from "./process-group-guardian.js";

export interface OwnedProcessHandle {
  kind: "process"; pid: number; pgid: number; pidStartedAt: number; hostname: string; bootIdentity: string;
}
export interface OwnedProcessLaunch { command: string; args: string[]; env: Record<string, string>; cwd: string }
export interface OwnedProcess {
  readonly handle: Readonly<OwnedProcessHandle>;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  launch(spec: OwnedProcessLaunch): Promise<void>;
  onMessage(listener: (value: unknown) => void): () => void;
  send(value: unknown): Promise<void>;
  stop(): Promise<void>;
  proveCessation(): boolean;
  dispose(): Promise<void>;
}
const maxMessage = 1024 * 1024;
/** Retain at installed-generation registration, before accepting executions. */
export function captureOwnedProcessBootstrap(): Buffer {
  return captureOwnedProcessEntrypoint(fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./owned-process-child.ts" : "./owned-process-child.js", import.meta.url)));
}
/** Small trusted bootstrap only; dynamic application packages need their own
 * retained dependency/resource graph, never an external installed-path link. */
export function captureOwnedProcessEntrypoint(entrypoint: string): Buffer {
  if (!isAbsolute(entrypoint)) throw new Error("Owned process entrypoint must be absolute");
  const { buildSync } = createRequire(import.meta.url)("esbuild") as typeof import("esbuild");
  const bundle = buildSync({ entryPoints: [entrypoint], bundle: true, platform: "node", format: "esm", target: "node26", write: false, metafile: true });
  if (Object.values(bundle.metafile!.outputs).some(output => output.imports.some(item => item.external && !isBuiltin(item.path)))) throw new Error("Owned process bootstrap has an external module dependency");
  // Bundled CommonJS may still require Node builtins (for example YAML's
  // process/buffer imports). Supply only that missing ESM runtime operation,
  // after linking so ordinary static package dependencies remain bundled.
  // Keep bridge names inside an IIFE: captured entrypoints can be captured
  // again, and another top-level import would collide with the first banner.
  // No ambient require, require.resolve/cache, or dynamic package loading is
  // inherited. This executes in the fresh captured Node26 child, never here.
  const builtins = `globalThis.require=((module)=>{const load=module.createRequire(import.meta.url);return specifier=>{if(typeof specifier!=='string'||!module.isBuiltin(specifier))throw Error('OwnedProcessBuiltinRequireOnly');return load(specifier)}})(globalThis.process.getBuiltinModule('module'));\n`;
  const output = Buffer.from(bundle.outputFiles[0].contents);
  const header = output[0] === 35 && output[1] === 33 ? output.indexOf(10) + 1 : 0;
  return Buffer.concat([output.subarray(0, header), Buffer.from(builtins), output.subarray(header)]);
}
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Owned process cessation remains unknown")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** The guardian has no application or credentials until launch after durable publication. */
export async function prepareOwnedProcess(options: { deadline: number; tempRoot?: string; runtime?: string; bootstrap?: Buffer }): Promise<OwnedProcess> {
  if (process.platform === "win32" || !Number.isFinite(options.deadline) || options.deadline <= Date.now()) throw new Error("Owned process requires an available Unix deadline");
  if (options.tempRoot && !isAbsolute(options.tempRoot)) throw new Error("Owned process temporary root must be absolute");
  const runtime = options.runtime ?? process.execPath, bytes = options.bootstrap ?? captureOwnedProcessBootstrap();
  if (!isAbsolute(runtime) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxMessage) throw new Error("Owned process retained bootstrap is unavailable");
  const directory = mkdtempSync(join(options.tempRoot ?? tmpdir(), "workflow-owned-process-"));
  const bootstrap = join(directory, "guardian.mjs"), token = randomUUID();
  writeFileSync(bootstrap, bytes, { mode: 0o500, flag: "wx" });
  const child = spawn(runtime, [bootstrap, token, String(options.deadline)], {
    detached: true, cwd: directory, env: { PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let done = false, launched = false, escapedDescendants: EscapedDescendantIdentity[] = [];
  let ready!: () => void, rejectReady!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => { ready = resolve;rejectReady = reject; });
  let launchResolve: (() => void) | undefined, launchReject: ((error: Error) => void) | undefined;
  const listeners = new Set<(value: unknown) => void>();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => {
    done = true;rejectReady(new Error("Owned guardian closed before readiness"));launchReject?.(new Error("Owned application did not start"));resolve({ code, signal });
  }));
  child.once("error", () => rejectReady(new Error("Owned guardian could not start")));
  const send = (kind: string, value?: unknown) => new Promise<void>((resolve, reject) => {
    let message: object;
    try {
      message = { version: 1, token, kind, ...(value === undefined ? {} : { value }) };
      if (Buffer.byteLength(JSON.stringify(message)) > maxMessage) throw new Error("Owned process message exceeds its budget");
      if (done || !child.connected) throw new Error("Owned guardian is unavailable");
      child.send(message, error => error ? reject(new Error("Owned process delivery failed")) : resolve());
    } catch (error) { reject(error); }
  });
  child.on("message", raw => {
    const message = raw as { version?: number; token?: string; kind?: string; value?: unknown };
    if (message.version !== 1 || message.token !== token) { child.kill("SIGTERM");return; }
    if (message.kind === "ready") ready();
    else if (message.kind === "launched") launchResolve?.();
    else if (message.kind === "failed") launchReject?.(new Error("Owned application refused its launch"));
    else if (message.kind === "escaped" && Array.isArray(message.value)) {
      escapedDescendants = message.value.filter((item): item is EscapedDescendantIdentity =>
        Boolean(item && typeof item === "object" && "pid" in item && typeof item.pid === "number" && Number.isInteger(item.pid) && item.pid > 0 && "start" in item && typeof item.start === "string" && item.start.length > 0));
    }
    else if (message.kind === "message") {
      if (Buffer.byteLength(JSON.stringify(message)) > maxMessage) { child.kill("SIGTERM");return; }
      for (const listener of listeners) {
        try { listener(message.value); } catch { child.kill("SIGTERM"); }
      }
    }
  });
  const startupTimer = setTimeout(() => { rejectReady(new Error("Owned guardian readiness expired"));child.kill("SIGTERM"); }, 10000);
  let handle: OwnedProcessHandle;
  try {
    await readiness;
    if (!child.pid || done) throw new Error("Owned guardian is unavailable");
    const start = Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8", timeout: 300 }).trim());
    const pgid = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(child.pid)], { encoding: "utf8", timeout: 300 }).trim());
    if (!Number.isFinite(start) || pgid !== child.pid) throw new Error("Owned guardian identity is unavailable");
    handle = { kind: "process", pid: child.pid, pgid, pidStartedAt: Math.floor(start / 1000), hostname: hostname(), bootIdentity: processBootIdentity() };
  } catch (error) {
    child.kill("SIGTERM");await bounded(closed, 6500);
    try { if (child.pid) process.kill(-child.pid, 0);else rmSync(directory, { recursive: true, force: true }); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") rmSync(directory, { recursive: true, force: true }); }
    throw error;
  } finally { clearTimeout(startupTimer); }
  const proveCessation = () => {
    if (!done || handle.bootIdentity !== processBootIdentity() || handle.hostname !== hostname()) return false;
    return guardianDescendantsAbsent(handle.pid, handle.pidStartedAt, escapedDescendants);
  };
  const stop = async () => {
    if (!done) {
      // IPC delivery itself can be blocked. Observation is bounded independently
      // of its callback; only the guardian may signal its whole live group.
      void send("stop").catch(() => { child.kill("SIGTERM"); });
      await bounded(closed, 6500);
    }
    let ceased = proveCessation();
    const until = Date.now() + 1000;
    while (!ceased && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 25));
      ceased = proveCessation();
    }
    if (!ceased) throw new Error("Owned process cessation remains unknown");
  };
  return { handle: Object.freeze(handle), closed,
    launch: async spec => {
      if (launched || done || Date.now() >= options.deadline) throw new Error("Owned process launch is fenced");
      launched = true;
      const started = new Promise<void>((resolve, reject) => { launchResolve = resolve;launchReject = reject; });
      try { await Promise.all([send("launch", spec), started]); }
      catch (error) { launchReject?.(error instanceof Error ? error : new Error("Owned launch failed"));await stop();throw error; }
    },
    onMessage: listener => { listeners.add(listener);return () => listeners.delete(listener); },
    send: value => send("message", value), stop, proveCessation,
    dispose: async () => { await stop();rmSync(directory, { recursive: true, force: true }); },
  };
}
