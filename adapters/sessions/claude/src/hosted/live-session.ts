import {createLogger} from "@barry-rocks/sdk/logging";
const cancellationLog=createLogger("claude-live");
/** Claude hosted keeps one streaming Agent SDK query open across turns.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */
import { withDeadline, envMs, NotSupportedInMode } from "@barry-rocks/sdk/sessions";
import type { Guarantees } from "@barry-rocks/sdk/adapters/harnesses";
import type { JsonSchema } from "@barry-rocks/sdk/ids";
import type {
  DeliveryOptions,
  DeliveryReceipt,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionEvent,
} from "@barry-rocks/sdk/sessions";

/** One user message, in the shape the SDK's streaming prompt takes. */
export interface UserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/** What the session needs of the SDK's query: its messages, an interrupt, and an end. */
export interface LiveQuery {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  /** Resolves once the SDK has stopped the turn; what it resolves to is not read. */
  interrupt(): Promise<unknown>;
  close(): void;
}

export interface ClaudeLiveOptions {
  id: string;
  guarantees: Guarantees;
  /** Open the streaming query over `prompt`, continuing `resume` when given. */
  open(prompt: AsyncIterable<UserMessage>, resume: string | undefined, warm?: boolean): Promise<LiveQuery>;
  /** One SDK message, as session events. */
  toEvents(message: unknown): Iterable<SessionEvent>;
  /** A turn with an output schema: one-shot, in a conversation of its own. */
  structuredTurn(content: string, schema: JsonSchema, signal: AbortSignal): AsyncIterable<SessionEvent>;
  /** The conversation to continue rather than start. */
  abortOpen?():void;
  resume?: string;
  /** How long an idle session keeps its process. Absent keeps it until close. */
  releaseAfterMs?: number;
}

interface PendingTurn {
  content: string;
  outputSchema?: JsonSchema;
}

interface Link {
  prompt: PromptStream;
  query: LiveQuery;
}

type TurnEnd = { error: string } | { closed: true };

export class ClaudeLiveSession implements Session {
  readonly mode = "hosted" as const;
  readonly guarantees: Guarantees;

  private conversationId: string | null = null;
  private version: string | null = null;
  private link: Link | null = null;
  private opening: Promise<Link> | null = null;
  private releaseTimer: NodeJS.Timeout | null = null;

  private state: "idle" | "active" | "error" = "idle";
  /** True from a turn's start until its one `done` has been emitted. */
  private turnOpen = false;
  /** Which turn is open, so a late failure cannot end the next one. */
  private turnNumber = 0;
  /** The open turn runs one-shot, not on the live query. */
  private turnStructured: AbortController | null = null;
  private interruptWanted = false;

  private readonly pending: PendingTurn[] = [];
  private readonly buffered: SessionEvent[] = [];
  private readonly waiting: Array<(next: IteratorResult<SessionEvent>) => void> = [];
  private closed = false;
  private messageCount = 0;
  private readonly options: ClaudeLiveOptions;

  constructor(options: ClaudeLiveOptions) {
    this.options = options;
    this.guarantees = { ...options.guarantees };
  }

  get id(): string {
    return this.options.id;
  }

  get harnessSessionId(): string | null {
    return this.conversationId ?? this.options.resume ?? null;
  }

  get harnessVersion(): string | null {
    return this.version;
  }

  status(): "idle" | "active" | "error" {
    return this.state;
  }

  events(): AsyncIterable<SessionEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const event = this.buffered.shift();
          if (event) return Promise.resolve({ done: false, value: event });
          if (this.closed) return Promise.resolve({ done: true, value: undefined });
          return new Promise<IteratorResult<SessionEvent>>((resolve) => this.waiting.push(resolve));
        },
      }),
    };
  }

  /**
   * A message at idle starts a turn. Mid-turn it is folded into the running
   * turn when asked to steer and that turn is on the live query; otherwise it
   * waits for the turn to end.
   *
   * A turn that cannot start ends with an error event rather than a rejection
   * here: the events are where a turn's outcome is read.
   */
  async warm(): Promise<void> {
    if (this.closed) throw new Error(`session ${this.options.id} is closed`);
    await this.linked(true);
    this.scheduleRelease();
  }

  async deliver(content: string, options: DeliveryOptions = {}): Promise<DeliveryReceipt> {
    if (this.closed) throw new Error(`session ${this.options.id} is closed`);
    const messageId = `${this.options.id}-msg-${++this.messageCount}`;
    const turn: PendingTurn = { content, ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}) };
    if (!this.turnOpen) {
      this.beginTurn(turn);
      return { messageId, status: "started" };
    }
    if (options.ifActive === "steer" && !this.turnStructured && !options.outputSchema && this.link) {
      this.link.prompt.push(content, this.harnessSessionId);
      return { messageId, status: "steered" };
    }
    this.pending.push(turn);
    return { messageId, status: "queued" };
  }

  async interrupt(): Promise<void> {
    if (!this.turnOpen) return;
    cancellationLog.info("interrupt.received",{sessionId:this.id,turn:this.turnNumber});
    if (this.turnStructured) {
      this.turnStructured.abort();
      return;
    }
    // Asked while the process is still starting: sent once it has.
    if (!this.link) {
      this.interruptWanted = true;
      return;
    }
    await withDeadline(this.link.query.interrupt(),envMs("BARRY_INTERRUPT_DEADLINE_MS",10_000));
  }

  async answer(_request: PermissionRequest, _decision: PermissionDecision): Promise<void> {
    // Barry rules in the hook and nothing else answers a call.
    throw new NotSupportedInMode("answer", "hosted");
  }

  /**
   * Compact the conversation. The Claude Agent SDK compacts when it sees the
   * `/compact` slash command in the prompt stream, so compaction here is a
   * normal delivery of that literal — but exposed as the `compact` capability
   * (SES-22) so the API answers 501 for harnesses that have no such command,
   * rather than recording `/compact` as a user message there.
   */
  async compact(): Promise<void> {
    await this.deliver("/compact");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    cancellationLog.info("session.close",{sessionId:this.id,turn:this.turnNumber});
    this.options.abortOpen?.();
    this.cancelRelease();
    this.pending.length = 0;
    // The turn's reader is owed its end even when the session goes first.
    if (this.turnOpen) this.endTurn({ closed: true });
    this.cancelRelease();
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) resolve({ done: true, value: undefined });
    this.turnStructured?.abort();
    this.dropLink();
  }


  /** The live query, opened once: two opens would split the conversation between two processes. */
  private linked(warm = false): Promise<Link> {
    if (this.link) return Promise.resolve(this.link);
    this.opening ??= this.openLink(warm).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openLink(warm: boolean): Promise<Link> {
    const prompt = new PromptStream();
    const query = await this.options.open(prompt, this.harnessSessionId ?? undefined, warm);
    if (this.closed) {
      prompt.close();
      query.close();
      throw new Error(`session ${this.options.id} is closed`);
    }
    const link = { prompt, query };
    this.link = link;
    void this.pump(link);
    return link;
  }

  private async pump(link: Link): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const message of link.query) {
        if (this.link !== link) break;
        this.noteVersion(message);
        for (const event of this.options.toEvents(message)) this.onEvent(event);
      }
    } catch (err) {
      failure = messageOf(err);
    }
    if (this.link !== link) return;
    this.link = null;
    if (this.turnOpen && !this.turnStructured) {
      this.endTurn({ error: failure ?? "the claude process ended during the turn" });
    }
  }

  private dropLink(): void {
    const link = this.link;
    this.link = null;
    if (!link) return;
    link.prompt.close();
    link.query.close();
  }

  private onEvent(event: SessionEvent): void {
    if (event.type === "init") {
      // The SDK announces the conversation at every turn; the session, once.
      if (event.harnessSessionId === this.conversationId) return;
      this.conversationId = event.harnessSessionId;
      this.emit(event);
      return;
    }
    // A turn Barry did not start — a steered message the SDK answered on its
    // own — is still a turn: it opens here so it ends here, with its one `done`.
    if (!this.turnOpen) this.openTurn();
    this.emit(event);
    if (event.type === "done") this.finishTurn();
  }

  /** The build the SDK's process reports on init. */
  private noteVersion(message: unknown): void {
    const record = recordOf(message);
    if (record.type === "system" && record.subtype === "init" && typeof record.claude_code_version === "string") {
      this.version = record.claude_code_version;
    }
  }

  touch(): void { if (!this.turnOpen) this.scheduleRelease(); }
  isWarm(): boolean { return this.link !== null; }

  private scheduleRelease(): void {
    const after = this.options.releaseAfterMs;
    if (!after || this.closed) return;
    this.cancelRelease();
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (!this.turnOpen && !this.closed) { this.dropLink(); }
    }, after);
    this.releaseTimer.unref();
  }

  private cancelRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }


  private openTurn(): number {
    this.cancelRelease();
    this.turnOpen = true;
    this.interruptWanted = false;
    this.state = "active";
    return ++this.turnNumber;
  }

  /** Open a turn now, so a delivery arriving meanwhile queues behind it. */
  private beginTurn(turn: PendingTurn): void {
    const number = this.openTurn();
    if (turn.outputSchema) {
      const abort = new AbortController();
      this.turnStructured = abort;
      void this.runStructured(number, turn.content, turn.outputSchema, abort.signal);
    } else {
      void this.sendLive(number, turn.content);
    }
  }

  private async sendLive(number: number, content: string): Promise<void> {
    try {
      let link: Link;
      try { link = await this.linked(); }
      catch (error) {
        if (this.closed || this.turnNumber !== number || !this.turnOpen || this.interruptWanted) throw error;
        if (!/Subprocess initialization did not complete|initializ(?:e|ation|ing).*?(?:timeout|timed out)|(?:timeout|timed out).*initializ/i.test(messageOf(error))) throw error;
        this.emit({ type: "status", status: "retrying" });
        link = await this.linked();
      }
      if (this.turnNumber !== number || !this.turnOpen) return;
      link.prompt.push(content, this.harnessSessionId);
      if (this.interruptWanted) {
        this.interruptWanted = false;
        await withDeadline(link.query.interrupt(),envMs("BARRY_INTERRUPT_DEADLINE_MS",10_000));
      }
    } catch (err) {
      if (this.turnNumber === number && this.turnOpen) this.endTurn({ error: messageOf(err) });
    }
  }

  private async runStructured(number: number, content: string, schema: JsonSchema, signal: AbortSignal): Promise<void> {
    const current = () => this.turnNumber === number && this.turnOpen;
    try {
      for await (const event of this.options.structuredTurn(content, schema, signal)) {
        if (!current()) return;
        // The one-shot is a conversation of its own; its id is not this session's.
        if (event.type === "init") continue;
        this.emit(event);
        if (event.type === "done") {
          this.finishTurn();
          return;
        }
      }
      if (current()) this.endTurn({ error: signal.aborted ? "interrupted" : "the structured run ended without finishing its turn" });
    } catch (err) {
      if (current()) this.endTurn({ error: messageOf(err) });
    }
  }

  /** Close the open turn with its one `done`, and start whatever queued behind it. */
  private endTurn(end: TurnEnd): void {
    if ("error" in end) this.emit({ type: "error", error: end.error });
    this.emit({ type: "done" });
    // A turn lost with its process leaves the session in error until the next
    // delivery opens another.
    this.finishTurn("error" in end && !this.link ? "error" : "idle");
  }

  private finishTurn(settled: "idle" | "error" = "idle"): void {
    this.turnOpen = false;
    this.turnStructured = null;
    this.interruptWanted = false;
    this.state = settled;
    const next = this.pending.shift();
    if (next && !this.closed) this.beginTurn(next);
    else this.scheduleRelease();
  }


  private emit(event: SessionEvent): void {
    if (this.closed) return;
    const resolve = this.waiting.shift();
    if (resolve) resolve({ done: false, value: event });
    else this.buffered.push(event);
  }
}

/**
 * The query's prompt: messages Barry pushes, and between them an iterator
 * parked on a pending promise — which is what keeps the conversation open
 * rather than ending it.
 */
export class PromptStream implements AsyncIterable<UserMessage> {
  private readonly queued: UserMessage[] = [];
  private waiting: ((next: IteratorResult<UserMessage>) => void) | null = null;
  private ended = false;

  push(content: string, conversationId: string | null): void {
    if (this.ended) return;
    const message: UserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: conversationId ?? "",
    };
    const resolve = this.waiting;
    this.waiting = null;
    if (resolve) resolve({ done: false, value: message });
    else this.queued.push(message);
  }

  close(): void {
    this.ended = true;
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<UserMessage> {
    return {
      next: () => {
        const message = this.queued.shift();
        if (message) return Promise.resolve({ done: false, value: message });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<UserMessage>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
