/**
 * Supervisor service management for llama-server.
 *
 * Spawns, manages, and gracefully terminates local llama-server instances
 * running GGUF models with automatic port allocation and readiness probing.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface LlamaServerOptions {
  /** Path to llama-server binary. Defaults to BARRY_LLAMACPP_BIN or "llama-server". */
  bin?: string;
  /** Path to GGUF model file. */
  model: string;
  /** Host to bind. Defaults to "127.0.0.1". */
  host?: string;
  /** Port to listen on. */
  port: number;
  /** Context window size in tokens. Defaults to 4096. */
  ctxSize?: number;
  /** GPU layer offload count. Defaults to 99 on macOS Darwin, 0 elsewhere. */
  gpuLayers?: number;
  /** Additional command-line flags. */
  extraArgs?: string[];
  /** Graceful termination timeout before SIGKILL in ms. Defaults to 5000. */
  gracefulStopMs?: number;
  /** Working directory. */
  cwd?: string;
  /** Environment variables. */
  env?: Record<string, string | undefined>;
}

export function defaultGpuLayers(): number {
  return process.platform === "darwin" ? 99 : 0;
}

export function buildLlamaServerArgs(options: LlamaServerOptions): string[] {
  const host = options.host ?? "127.0.0.1";
  const ctxSize = options.ctxSize ?? 4096;
  const gpuLayers = options.gpuLayers ?? defaultGpuLayers();

  const args = [
    "-m",
    options.model,
    "--host",
    host,
    "--port",
    String(options.port),
    "-c",
    String(ctxSize),
    "-ngl",
    String(gpuLayers),
  ];

  if (options.extraArgs && options.extraArgs.length > 0) {
    args.push(...options.extraArgs);
  }

  return args;
}

export async function probeLlamaServer(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const healthUrl = `${root}/health`;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === "ok" || body.status === "loading model" || body.status !== undefined;
  } catch {
    return false;
  }
}

export class LlamaServerSupervisor {
  private child: ChildProcess | null = null;
  private running = false;
  private readonly options: LlamaServerOptions;

  constructor(options: LlamaServerOptions) {
    this.options = { ...options };
  }

  get url(): string {
    const host = this.options.host ?? "127.0.0.1";
    return `http://${host}:${this.options.port}`;
  }

  get v1Url(): string {
    return `${this.url}/v1`;
  }

  isRunning(): boolean {
    return this.running && this.child !== null && !this.child.killed;
  }

  getPid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.isRunning()) {
      return;
    }

    const bin = this.options.bin || process.env.BARRY_LLAMACPP_BIN || "llama-server";
    const args = buildLlamaServerArgs(this.options);

    const child = spawn(bin, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...(this.options.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child = child;
    this.running = true;

    child.on("exit", () => {
      this.running = false;
      this.child = null;
    });

    child.on("error", () => {
      this.running = false;
      this.child = null;
    });
  }

  async waitForReady(timeoutMs = 30_000, pollIntervalMs = 500): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.isRunning()) {
        return false;
      }
      const ready = await probeLlamaServer(this.url, Math.min(pollIntervalMs, 2000));
      if (ready) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return false;
  }

  async stop(): Promise<void> {
    if (!this.child) {
      this.running = false;
      return;
    }

    const child = this.child;
    const timeoutMs = this.options.gracefulStopMs ?? 5000;

    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          this.running = false;
          this.child = null;
          resolve();
        }
      };

      child.once("exit", done);

      child.kill("SIGTERM");

      setTimeout(() => {
        if (!resolved) {
          try {
            child.kill("SIGKILL");
          } catch {
            // child already exited
          }
          done();
        }
      }, timeoutMs);
    });
  }
}
