import {stopProcess as stopOwnedChild} from "@barry-rocks/sdk/sessions";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Guarantees } from "@barry-rocks/sdk/adapters/harnesses";
import { parseModelRef } from "@barry-rocks/sdk/ids";
import { EventQueue, NotSupportedInMode } from "@barry-rocks/sdk/sessions";
import type {
  DeliveryOptions,
  DeliveryReceipt,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionConfig,
  SessionEvent,
} from "@barry-rocks/sdk/sessions";
import { EXPERIMENTAL } from "../modes.js";
import { PIN_ENV, resolveAntigravityBin } from "../bin.js";
import { requireIdentityKey } from "../credential.js";
import { mapAgyEventToSessionEvents, type AgyStreamMessage } from "../event-mapping.js";
import { writeAntigravityWorkspace, type WorkspacePlan } from "../workspace.js";

export interface AntigravityHostedOptions {
  guarantees: Guarantees;
  releaseAfterMs?: number;
}

export class AntigravityStreamSession implements Session {
  readonly mode = "hosted" as const;
  readonly id: string;
  readonly guarantees: Guarantees;
  readonly harnessVersion = null;
  readonly warnings = [`Antigravity is experimental: ${EXPERIMENTAL}`];

  private harnessSessionIdVal: string | null = null;
  private process_: ChildProcess | null = null;
  private processSchema: string | undefined;
  private workspace: WorkspacePlan | null = null;
  private eventQueue = new EventQueue<SessionEvent>();
  private sessionState: "idle" | "active" | "error" = "idle";
  private releaseTimer: NodeJS.Timeout | null = null;
  private pendingQueue: Array<{ content: string; options?: DeliveryOptions; messageId: string }> = [];
  private closed = false;
  private turnOpen = false;
  private stopping: Promise<void> = Promise.resolve();
  private messageCounter = 0;

  constructor(
    private readonly config: SessionConfig,
    private readonly options: AntigravityHostedOptions,
  ) {
    requireIdentityKey(config.env);
    this.id = config.sessionId;
    this.guarantees = options.guarantees;
    this.harnessSessionIdVal = config.resume?.harnessSessionId ?? null;

  }

  get harnessSessionId(): string | null {
    return this.harnessSessionIdVal;
  }

  status(): "idle" | "active" | "error" {
    return this.sessionState;
  }

  events(): AsyncIterable<SessionEvent> {
    return this.eventQueue;
  }

  async deliver(content: string, options?: DeliveryOptions): Promise<DeliveryReceipt> {
    if (this.closed) throw new Error("Session is closed");

    this.messageCounter += 1;
    const messageId = `msg-${this.messageCounter}`;

    if (this.sessionState === "active") {
      this.pendingQueue.push({ content, options, messageId });
      return { messageId, status: "queued" };
    }

    this.sessionState = "active";
    this.turnOpen = true;
    try {
      await this.stopping;
      await this.ensureProcess(options?.outputSchema ? JSON.stringify(options.outputSchema) : undefined);
    } catch (err) {
      this.failTurn(err instanceof Error ? err.message : String(err));
      throw err;
    }
    this.clearReleaseTimer();
    this.writePrompt(content);

    return { messageId, status: "started" };
  }

  async interrupt(): Promise<void> {
    if (this.sessionState !== "active") return;
    const child = this.process_;
    if (child) {
      this.process_ = null;
      this.stopping = this.stopProcess(child, "SIGINT");
      await this.stopping;
    }
    if (this.turnOpen) {
      this.turnOpen = false;
      this.sessionState = "idle";
      this.eventQueue.push({ type: "done" });
      this.drainNextPending();
    }
  }

  async answer(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {
    // The hook script rules calls; nothing asks Barry for an answer.
    throw new NotSupportedInMode("answer", "hosted");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if(this.turnOpen){this.turnOpen=false;this.eventQueue.push({type:"done"});}
    this.pendingQueue = [];
    this.clearReleaseTimer();
    if (this.process_) {
      const child = this.process_;
      this.process_ = null;
      await this.stopProcess(child, "SIGTERM");
    }
    if (this.workspace) {
      this.workspace = null;
    }
    this.sessionState = "idle";
    this.eventQueue.end();
  }

  private writePrompt(prompt: string): void {
    if (!this.process_?.stdin || this.process_.stdin.destroyed) {
      this.failTurn("Process stdin is not available");
      return;
    }

    const payload = JSON.stringify({
      event: "user",
      message: {
        content: prompt,
      },
    });
    this.process_.stdin.write(payload + "\n");
  }

  private async ensureProcess(jsonSchema?: string): Promise<void> {
    if (this.process_ && !this.process_.killed) {
      if (this.processSchema === jsonSchema) return;
      const child = this.process_;
      this.process_ = null;
      await this.stopProcess(child, "SIGTERM");
    }
    this.processSchema = jsonSchema;

    this.workspace = writeAntigravityWorkspace(this.config, Boolean(jsonSchema));

    const bin = resolveAntigravityBin(this.config.env);
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print=",
      "--dangerously-skip-permissions",
      "--add-dir", this.config.cwd,
    ];

    if (this.config.model) {
      const parsed = parseModelRef(this.config.model);
      args.push("--model", parsed?.model ?? this.config.model);
    }

    if (this.harnessSessionIdVal) {
      args.push("--conversation", this.harnessSessionIdVal);
    }

    if (jsonSchema) {
      args.push("--json-schema", jsonSchema);
    }

    if (this.config.egressSandbox) {
      args.push("--sandbox");
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.config.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    if (!env.PATH && process.env.PATH) env.PATH = process.env.PATH;
    if (!env.TMPDIR && process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    env.HOME = this.workspace.workspaceDir;
    Object.assign(env, PIN_ENV);
    if (this.config.endpoint?.baseUrl) {
      env.GOOGLE_GEMINI_BASE_URL = this.config.endpoint.baseUrl;
    }
    if (this.config.endpoint?.apiKey) {
      env.GEMINI_API_KEY = this.config.endpoint.apiKey;
    }

    const child = spawn(bin, args, {
      cwd: this.workspace.workspaceDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process_ = child;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (this.process_ !== child || this.closed || !line.trim()) return;
      try {
        const msg = JSON.parse(line) as AgyStreamMessage;
        if (msg.event === "init" && msg.conversation_id) {
          this.harnessSessionIdVal = msg.conversation_id;
        }
        for (const ev of mapAgyEventToSessionEvents(msg)) {
          if ((ev.type === "done" || ev.type === "result") && !this.turnOpen) continue;
          if (ev.type === "result" && ev.structured === undefined && this.processSchema && ev.result !== undefined) {
            this.eventQueue.push({ ...ev, structured: JSON.parse(ev.result) });
          } else this.eventQueue.push(ev);
          if (ev.type === "done") {
            this.turnOpen = false;
            this.sessionState = "idle";
            this.scheduleRelease();
            this.drainNextPending();
          }
        }
      } catch {
        this.failTurn("Antigravity emitted malformed stream JSON");
      }
    });

    child.on("error", (err) => {
      if (this.process_ !== child) return;
      this.process_ = null;
      this.failTurn(err.message);
    });
    child.on("exit", (code, signal) => {
      if (this.process_ !== child) return;
      this.process_ = null;
      if (this.turnOpen) this.failTurn(`Antigravity exited during a turn (${signal ?? code})`);
    });
    // Drain stderr so a verbose child cannot fill its pipe and deadlock.
    child.stderr?.resume();
  }

  private failTurn(error: string): void {
    if (this.closed || !this.turnOpen) return;
    this.turnOpen = false;
    this.sessionState = "error";
    this.eventQueue.push({ type: "error", error });
    this.eventQueue.push({ type: "done" });
    const child = this.process_;
    this.process_ = null;
    if (child) this.stopping = this.stopProcess(child, "SIGTERM");
    this.drainNextPending();
  }

  private drainNextPending(): void {
    if (this.closed || this.pendingQueue.length === 0 || this.sessionState === "active") return;
    const next = this.pendingQueue.shift();
    if (!next) return;
    void this.deliver(next.content, next.options).catch(() => undefined);
  }

  private scheduleRelease(): void {
    this.clearReleaseTimer();
    const after = this.options.releaseAfterMs;
    if (!after || this.closed) return;
    this.releaseTimer = setTimeout(() => {
      if (this.sessionState === "idle" && this.process_) {
        const child = this.process_;
        this.process_ = null;
        this.stopping = this.stopProcess(child, "SIGTERM");
      }
    }, after);
    this.releaseTimer.unref();
  }

  private stopProcess(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
    return stopOwnedChild(child,1000,signal);
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }
}

export function startAntigravityHosted(
  config: SessionConfig,
  options: AntigravityHostedOptions,
): Session {
  return new AntigravityStreamSession(config, options);
}
