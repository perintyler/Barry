import { spawn, exec, execFile, type ChildProcess } from "node:child_process";
import { accessSync, constants, rmSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { getServicePort } from "@barry-rocks/sdk/services";
import { startServerTurn, type SessionApi } from "../sessions/launch.js";
import { runHostedTerminal, type SessionUpdate } from "../commands/hosted-terminal.js";
import { cliName } from "../scope.js";

/** Pluggable UI renderers supported by Barry CLI. */
export type UiRenderer = "btui" | "web" | "app" | "raw" | "none";

/** Options passed to resolveUiRenderer. */
export interface UiResolveOptions {
  ui?: string | boolean;
  noUi?: boolean;
}

/** Identity structure with optional UI preference. */
export interface UiResolveIdentity {
  ui?: string | null;
  configuration?: {
    ui?: string | null;
  } | null;
}

/** Probing environment and capability overrides for testing and custom runners. */
export interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
  hasBinary?: (binary: string) => boolean;
}

/** Context information for launching a session UI. */
export interface SessionUiContext {
  sessionId: string;
  tmpDirs?: string[];
  harness?: string;
  model?: string;
  modelProvider?: string;
  prompt?: string;
  once?: boolean;
  repoPath?: string;
  [key: string]: unknown;
}

export type UiSpawnChild = Pick<ChildProcess, "on" | "once" | "kill" | "pid">;

export type UiSpawnFn = (
  command: string,
  args: readonly string[],
  options: { stdio?: "inherit" | "pipe" | "ignore"; env?: NodeJS.ProcessEnv },
) => UiSpawnChild;

/** Options for launchSessionUi. */
export interface LaunchUiOptions extends UiResolveOptions {
  renderer?: UiRenderer;
  selectedIdentity?: UiResolveIdentity | null;
  apiPort?: number;
  apiBase?: string;
  apiHeaders?: Record<string, string>;
  probe?: ProbeOptions;
  env?: NodeJS.ProcessEnv;
  spawn?: UiSpawnFn;
  exec?: typeof exec;
  openBrowser?: (url: string) => Promise<void> | void;
  openApp?: (url: string) => Promise<void> | void;
  cleanupTmpDirs?: (dirs?: string[]) => void;
  printResumeHint?: (sessionId: string) => void;
  startTurn?: (
    sessionId: string,
    params: Record<string, unknown>,
    api: SessionApi,
  ) => Promise<string | null>;
  runRawTerminal?: (ctx: SessionUiContext, options: LaunchUiOptions) => Promise<number>;
  exit?: (code: number) => never | void;
  stdout?: { write: (str: string) => void };
  stderr?: { write: (str: string) => void };
}

/** Result of UI launch dispatch. */
export interface UiLaunchResult {
  renderer: UiRenderer;
  exitCode: number;
}

/**
 * Normalizes input string to a known UiRenderer, or null if unrecognized.
 * Recognizes aliases such as 'readline' -> 'raw', 'browser' -> 'web', 'desktop' -> 'app'.
 */
export function normalizeRenderer(value: unknown): UiRenderer | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "btui") return "btui";
  if (trimmed === "web" || trimmed === "browser") return "web";
  if (trimmed === "app" || trimmed === "desktop") return "app";
  if (trimmed === "raw" || trimmed === "readline" || trimmed === "terminal" || trimmed === "cli") return "raw";
  if (trimmed === "none" || trimmed === "no-ui" || trimmed === "false") return "none";
  return null;
}

/**
 * Probes the PATH environment variable to check if an executable binary exists.
 */
export function probeBinary(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathVal = env.PATH;
  if (!pathVal) return false;
  const pathDirs = pathVal.split(process.platform === "win32" ? ";" : ":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    const fullPath = join(dir, name);
    try {
      accessSync(fullPath, constants.X_OK);
      return true;
    } catch {
      // Continue search
    }
  }
  return false;
}

/**
 * Resolves which UI renderer should attach to a session:
 * 1. CLI flags (`--no-ui`, `--ui <renderer>`)
 * 2. Environment variable (`BARRY_UI`)
 * 3. Identity configuration (`ui: btui` in identity.yaml or identity.ui)
 * 4. TTY / PATH probe fallback (if TTY and `which btui`, use `btui`, else fallback to `raw`/`readline`)
 */
export function resolveUiRenderer(
  options?: UiResolveOptions,
  identity?: UiResolveIdentity | null,
  probe?: ProbeOptions,
): UiRenderer {
  // 1. CLI flags
  if (options?.noUi === true || options?.ui === false) {
    return "none";
  }
  if (typeof options?.ui === "string" && options.ui.trim()) {
    const normalized = normalizeRenderer(options.ui);
    if (!normalized) {
      throw new Error(`Invalid UI renderer "${options.ui}". Supported renderers: btui, web, app, raw, none`);
    }
    return normalized;
  }

  // 2. Environment variable BARRY_UI
  const env = probe?.env ?? process.env;
  const envVal = env.BARRY_UI?.trim();
  if (envVal) {
    const normalized = normalizeRenderer(envVal);
    if (!normalized) {
      throw new Error(`Invalid UI renderer in BARRY_UI "${envVal}". Supported renderers: btui, web, app, raw, none`);
    }
    return normalized;
  }

  // 3. Identity configuration (ui: btui in identity.yaml)
  const identityUi =
    (typeof identity?.configuration?.ui === "string"
      ? identity.configuration.ui
      : typeof identity?.ui === "string"
        ? identity.ui
        : undefined)?.trim();
  if (identityUi) {
    const normalized = normalizeRenderer(identityUi);
    if (!normalized) {
      throw new Error(`Invalid UI renderer in identity config "${identityUi}". Supported renderers: btui, web, app, raw, none`);
    }
    return normalized;
  }

  // 4. TTY / PATH probe fallback (if TTY and which btui, use btui, else fallback to raw/readline)
  const isTty = probe?.isTty ?? Boolean(process.stdout?.isTTY && process.stdin?.isTTY);
  const hasBinary = probe?.hasBinary ?? ((bin: string) => probeBinary(bin, env));

  if (isTty && hasBinary("btui")) {
    return "btui";
  }

  return "raw";
}

/** Default helper to clean temporary directories. */
export function defaultCleanupTmpDirs(tmpDirs?: string[]): void {
  if (!tmpDirs || tmpDirs.length === 0) return;
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/** Default helper to print session resume hint. */
export function defaultPrintResumeHint(sessionId: string): void {
  console.log(`\nSession: ${sessionId}`);
  console.log(`  ${cliName()} session resume ${sessionId}`);
}

const defaultExit = (code: number): void => {
  process.exit(code);
};

/**
 * Open a URL or app scheme with the OS handler (CLI-15). One definition, and
 * `execFile` with an argv array rather than a shell string so a crafted URL
 * cannot inject a command. Barry runs on macOS and Linux (see the support
 * policy); there is no win32 branch to drift.
 */
export function openUrl(url: string, runner = execFile): Promise<void> {
  return new Promise((resolve, reject) => {
    const [command, args] = process.platform === "darwin" ? ["open", [url]] as const : ["xdg-open", [url]] as const;
    runner(command, args, (err) => (err ? reject(err) : resolve()));
  });
}

/** Default helper to launch a browser. */
export const defaultOpenBrowser = (url: string): Promise<void> => openUrl(url);

/** Default helper to launch a desktop app via URL scheme. */
export const defaultOpenApp = (url: string): Promise<void> => openUrl(url);

function defaultApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.BARRY_SECRET) {
    headers["Authorization"] = `Bearer ${process.env.BARRY_SECRET}`;
  }
  return headers;
}

function getApiBase(customBase?: string, customPort?: number): string {
  if (customBase) return customBase;
  const port = customPort ?? getServicePort("api");
  return `http://localhost:${port}/api/v1`;
}

async function sendPromptTurn(
  ctx: SessionUiContext,
  options: LaunchUiOptions,
  api: SessionApi,
): Promise<string | null> {
  if (!ctx.prompt) return null;
  const startTurnFn = options.startTurn ?? (async (id, params, a) => {
    return await startServerTurn(id, {
      harness: (params.harness as string) ?? "hosted",
      prompt: (params.prompt as string) ?? "",
      model: params.model as string | undefined,
      modelProvider: params.modelProvider as string | undefined,
      repoPath: (params.repoPath as string) ?? process.cwd(),
    }, a);
  });
  return await startTurnFn(ctx.sessionId, {
    harness: ctx.harness ?? "hosted",
    prompt: ctx.prompt,
    model: ctx.model,
    modelProvider: ctx.modelProvider,
    repoPath: ctx.repoPath ?? process.cwd(),
  }, api);
}

function socketUpdates(socket: WebSocket): AsyncIterable<SessionUpdate> {
  const queued: SessionUpdate[] = [];
  let wake: (() => void) | null = null;
  socket.on("message", (data) => {
    try {
      queued.push(JSON.parse(String(data)) as SessionUpdate);
    } catch {
      return;
    }
    const resolve = wake;
    wake = null;
    resolve?.();
  });
  return {
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
}

/**
 * Runs the raw terminal / readline interface connected to the Barry API.
 */
async function defaultRunRawTerminal(
  ctx: SessionUiContext,
  options: LaunchUiOptions,
): Promise<number> {
  const { createInterface } = await import("node:readline");
  const port = options.apiPort ?? getServicePort("api");
  const base = getApiBase(options.apiBase, options.apiPort);
  const { sessionId } = ctx;
  const headers = options.apiHeaders ?? defaultApiHeaders();

  const socket = new WebSocket(`ws://localhost:${port}/api/v1/ws`, { headers });
  const updates = socketUpdates(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
  } catch (err) {
    const errLog = options.stderr ? (s: string) => options.stderr!.write(s + "\n") : console.error;
    errLog(`Could not reach Barry's API: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const subscribe = () => socket.send(JSON.stringify({ type: "subscribe", sessionId }));
  subscribe();

  const lines = ctx.once ? null : createInterface({ input: process.stdin, output: process.stdout, prompt: "› " });
  const typed = lines?.[Symbol.asyncIterator]();
  const terminal = runHostedTerminal(
    {
      read: async () => {
        if (!lines || !typed) return null;
        lines.prompt();
        const next = await typed.next();
        return next.done ? null : next.value;
      },
      write: (text) => process.stdout.write(text),
    },
    {
      send: async (content, first) => {
        if (first) {
          const refused = await sendPromptTurn({ ...ctx, prompt: content }, options, { base, headers });
          if (!refused) subscribe();
          return refused;
        }
        const sent = await fetch(`${base}/sessions/${sessionId}/message`, {
          method: "POST",
          headers,
          body: JSON.stringify({ content }),
        });
        if (sent.ok) return null;
        const body = (await sent.json().catch(() => ({}))) as { error?: string; detail?: string };
        return body.error ?? body.detail ?? `HTTP ${sent.status}`;
      },
      interrupt: async () => {
        await fetch(`${base}/sessions/${sessionId}/interrupt`, { method: "POST", headers });
      },
    },
    updates,
    { ...(ctx.prompt ? { prompt: ctx.prompt } : {}), once: ctx.once },
  );

  return await new Promise<number>((resolve) => {
    let closed = false;
    const leave = (code: number) => {
      if (closed) return;
      closed = true;
      lines?.close();
      socket.close();
      resolve(code);
    };

    const onInterrupt = () => {
      void terminal.interrupt().then((interrupted) => {
        if (!interrupted) leave(130);
      });
    };

    if (lines) lines.on("SIGINT", onInterrupt);
    else process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", () => leave(0));
    socket.on("close", () => leave(0));

    void terminal.done.then((code) => leave(code));
  });
}

/**
 * Dispatches session presentation to the resolved or specified pluggable UI renderer.
 *
 * Supported renderers:
 * - `btui`: Spawns `btui <sessionId>` with `stdio: inherit` and graceful detachment (exit 0).
 *           Falls back to `raw` terminal if the binary is missing or fails to launch.
 * - `web`: Opens session in default browser (`http://localhost:<port>/sessions/<sessionId>`).
 * - `app`: Opens session in desktop app (`barry://<sessionId>`).
 * - `none`: Background execution: writes only the session ID to stdout.
 * - `raw`: Basic terminal readline interface over WebSocket/HTTP.
 */
export async function launchSessionUi(
  ctx: SessionUiContext,
  options: LaunchUiOptions = {},
): Promise<UiLaunchResult> {
  const renderer =
    options.renderer ??
    resolveUiRenderer(options, options.selectedIdentity, options.probe);

  const cleanup = options.cleanupTmpDirs ?? defaultCleanupTmpDirs;
  const printHint = options.printResumeHint ?? defaultPrintResumeHint;
  const outLog = options.stdout ? (s: string) => options.stdout!.write(s + "\n") : console.log;
  const errLog = options.stderr ? (s: string) => options.stderr!.write(s + "\n") : console.error;
  const exit = options.exit ?? defaultExit;
  const base = getApiBase(options.apiBase, options.apiPort);
  const headers = options.apiHeaders ?? defaultApiHeaders();
  const api: SessionApi = { base, headers };

  const { sessionId } = ctx;

  switch (renderer) {
    case "none": {
      if (ctx.prompt) {
        const refused = await sendPromptTurn(ctx, options, api);
        if (refused) {
          errLog(`Could not start turn: ${refused}`);
          cleanup(ctx.tmpDirs);
          exit(1);
          return { renderer: "none", exitCode: 1 };
        }
      }
      cleanup(ctx.tmpDirs);
      outLog(sessionId);
      exit(0);
      return { renderer: "none", exitCode: 0 };
    }

    case "web": {
      if (ctx.prompt) {
        const refused = await sendPromptTurn(ctx, options, api);
        if (refused) {
          errLog(`Could not start turn: ${refused}`);
          cleanup(ctx.tmpDirs);
          exit(1);
          return { renderer: "web", exitCode: 1 };
        }
      }
      cleanup(ctx.tmpDirs);
      const port = options.apiPort ?? getServicePort("api");
      const url = options.apiBase
        ? `${options.apiBase.replace(/\/api\/v1\/?$/, "")}/sessions/${sessionId}`
        : `http://localhost:${port}/sessions/${sessionId}`;
      const openBrowserFn = options.openBrowser ?? defaultOpenBrowser;
      await openBrowserFn(url);
      outLog(`Session ${sessionId} opened in browser: ${url}`);
      printHint(sessionId);
      exit(0);
      return { renderer: "web", exitCode: 0 };
    }

    case "app": {
      if (ctx.prompt) {
        const refused = await sendPromptTurn(ctx, options, api);
        if (refused) {
          errLog(`Could not start turn: ${refused}`);
          cleanup(ctx.tmpDirs);
          exit(1);
          return { renderer: "app", exitCode: 1 };
        }
      }
      cleanup(ctx.tmpDirs);
      const url = `barry://${sessionId}`;
      const openAppFn = options.openApp ?? defaultOpenApp;
      await openAppFn(url);
      outLog(`Session ${sessionId} opened in app: ${url}`);
      printHint(sessionId);
      exit(0);
      return { renderer: "app", exitCode: 0 };
    }

    case "btui": {
      if (ctx.prompt) {
        const refused = await sendPromptTurn(ctx, options, api);
        if (refused) {
          errLog(`Could not start turn: ${refused}`);
          cleanup(ctx.tmpDirs);
          exit(1);
          return { renderer: "btui", exitCode: 1 };
        }
      }

      const spawnFn = options.spawn ?? spawn;
      let child: UiSpawnChild;
      try {
        child = spawnFn("btui", [sessionId], {
          stdio: "inherit",
          env: options.env ?? process.env,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errLog(`Could not launch btui (${msg}); falling back to basic terminal.`);
        return await launchRawFallback(ctx, options);
      }

      const spawnSuccess = await new Promise<boolean>((resolve) => {
        child.once("error", (err) => {
          errLog(`btui launch failed (${err.message}); falling back to basic terminal.`);
          resolve(false);
        });
        child.once("spawn", () => resolve(true));
      });

      if (!spawnSuccess) {
        return await launchRawFallback(ctx, options);
      }

      const exitCode = await new Promise<number>((resolve) => {
        const onSignal = () => {
          try {
            child.kill();
          } catch {
            // Child process already dead or gone
          }
          // Detachment guarantee: clean exit
          resolve(0);
        };
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);

        child.on("close", () => {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
          // Graceful detachment: user exits btui, session remains hosted in background.
          resolve(0);
        });
      });

      cleanup(ctx.tmpDirs);
      printHint(sessionId);
      exit(exitCode);
      return { renderer: "btui", exitCode };
    }

    case "raw":
    default: {
      return await launchRawFallback(ctx, options);
    }
  }
}

async function launchRawFallback(
  ctx: SessionUiContext,
  options: LaunchUiOptions,
): Promise<UiLaunchResult> {
  const cleanup = options.cleanupTmpDirs ?? defaultCleanupTmpDirs;
  const printHint = options.printResumeHint ?? defaultPrintResumeHint;
  const exit = options.exit ?? defaultExit;

  const rawRunner = options.runRawTerminal ?? defaultRunRawTerminal;
  const exitCode = await rawRunner(ctx, options);
  cleanup(ctx.tmpDirs);
  printHint(ctx.sessionId);
  exit(exitCode);
  return { renderer: "raw", exitCode };
}
