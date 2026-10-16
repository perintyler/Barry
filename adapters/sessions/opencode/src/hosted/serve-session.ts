import { allowedNative } from "../native-tools.js";
/**
 * opencode hosted: a Barry-owned `opencode serve` per session.
 *
 * One server holds the conversation across turns, so a message can steer the
 * running turn, an interrupt stops the turn without ending the session, and
 * every call of Barry's own MCP tools is put to Barry first. Native tools are
 * denied outright (`permissionRules`).
 *
 * Owning the server is also the E6 fix: a bare `opencode` joins a per-user
 * background service that keeps the FIRST session's config, so every later
 * session ran with someone else's MCP servers. This server runs in the
 * session's own environment (`server/launch-env.ts`).
 *
 * The server is a means, not the session: it is released after a quiet spell
 * and started again, and the conversation — kept in the session's own opencode
 * data dir — is picked up by id.
 */
import { rmSync } from "node:fs";
import type { EngineHandle, Guarantees, StartEngine } from "@barry-rocks/sdk/adapters/harnesses";
import type { TokenUsage } from "@barry-rocks/sdk/adapters/models";
import type {
  DeliveryOptions,
  DeliveryReceipt,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionConfig,
  SessionEvent,
} from "@barry-rocks/sdk/sessions";
import { toOpenCodeMcpConfig } from "../mcp-config.js";
import { OpenCodeServerClient, readServerEvents } from "../server/client.js";
import {
  enabledProviders,
  openCodeEnv,
  openCodeHome,
  permissionRules,
  prepareRuntimeDir,
  sessionConfig,
} from "../server/launch-env.js";
import { openCodeEngineSpec } from "../server/start.js";
import {
  ASK_EVERY_CALL,
  itemEvents,
  messageOf,
  permissionOf,
  permissionReply,
  serveEventOf,
  sessionOf,
  stepTokensOf,
  type ServeEvent,
} from "./serve-events.js";

export interface OpenCodeHostedOptions {
  guarantees: Guarantees;
  /** How long an idle session keeps its server. Absent keeps it until close. */
  releaseAfterMs?: number;
  /** How long a new server gets to answer. */
  readyTimeoutMs?: number;
  /** How long a new server's MCP servers get to connect before it is prompted. */
  mcpTimeoutMs?: number;
  /** How long after they connect their tools are taken to be offered. Tests only. */
  mcpSettleMs?: number;
  /** Where sessions' opencode homes are kept. Tests only: the default is the bag's data dir. */
  homesRoot?: string;
}

/** Start a hosted opencode session: its server, ready and streaming events. */
export async function startOpenCodeHosted(
  config: SessionConfig,
  startEngine: StartEngine,
  options: OpenCodeHostedOptions,
): Promise<Session> {
  const identityEnv = definedEnv(config.env);
  const servers = Object.keys(config.mcpServers);
  const permissions = permissionRules(servers, config.deniedTools ?? [], allowedNative(config), "ask");
  const home = openCodeHome(config.sessionId, options.homesRoot);
  const runtimeDir = prepareRuntimeDir();
  const removeRuntimeDir = () => rmSync(runtimeDir, { recursive: true, force: true });
  const env = openCodeEnv({
    home,
    runtimeDir,
    identityEnv,
    config: sessionConfig({
      mcp: toOpenCodeMcpConfig(config.mcpServers),
      permissions,
      providers: enabledProviders(identityEnv, config.model),
      ...(config.model ? { model: config.model } : {}),
    }),
  });
  const spec = openCodeEngineSpec(config.sessionId, config.cwd, env);

  const connect = async (): Promise<OpenCodeConnection> => {
    const engine = await startEngine({
      ...spec,
      command: (address) => {
        const command = spec.command(address);
        return { ...command, env: { ...identityEnv, ...command.env } };
      },
    });
    try {
      const client = new OpenCodeServerClient({ baseUrl: `http://${engine.address}`, password: engine.password ?? "" });
      await waitUntilReady(client, options.readyTimeoutMs ?? 20_000);
      // A request carries the tools registered when it was sent, and the
      // server connects MCP servers after it answers: prompted at once, the
      // first turn ran without Barry's (verified on 2.0.24).
      await waitForMcpServers(client, servers, config.cwd, options.mcpTimeoutMs ?? 15_000, options.mcpSettleMs ?? MCP_SETTLE_MS);
      const version = await client.version();
      if (version) await engine.recordVersion(version.replace(/^v/, ""));
      // Subscribed before anything is asked of it, so no event is missed.
      const reading = new AbortController();
      const stream = await client.openEvents(reading.signal);
      return {
        client,
        events: readServerEvents(stream),
        engine,
        version: version ? version.replace(/^v/, "") : null,
        close: () => reading.abort(),
      };
    } catch (err) {
      await engine.stop();
      throw err;
    }
  };

  let connected: OpenCodeConnection;
  try {
    // Connected now so a harness that cannot start refuses here, and the
    // session knows the build it runs on before anything is recorded.
    connected = await connect();
  } catch (err) {
    removeRuntimeDir();
    throw err;
  }
  const decide = config.decide?.bind(config);
  const model = config.model ? modelOf(config.model) : undefined;
  return new OpenCodeServeSession({
    id: config.sessionId,
    connect,
    connected,
    directory: config.cwd,
    guarantees: options.guarantees,
    permissions,
    servers,
    ...(options.releaseAfterMs ? { releaseAfterMs: options.releaseAfterMs } : {}),
    ...(model ? { model } : {}),
    ...(config.resume?.harnessSessionId ? { resumeSessionId: config.resume.harnessSessionId } : {}),
    ...(decide ? { decide } : {}),
    onClose: ({ conversation }) => {
      removeRuntimeDir();
      // A session that never started a conversation leaves nothing to resume,
      // and its home is still ~6MB of opencode's database.
      if (!conversation) rmSync(home.root, { recursive: true, force: true });
    },
  });
}

/** One server and the client connected to it. */
export interface OpenCodeConnection {
  client: Pick<OpenCodeServerClient, "createSession" | "setPermissions" | "prompt" | "interrupt" | "replyPermission">;
  /** The server's events, until the connection ends. */
  events: AsyncIterable<Record<string, unknown>>;
  engine: Pick<EngineHandle, "stop">;
  /** The build the server reported. */
  version: string | null;
  /** Stop reading events. */
  close(): void;
}

export interface OpenCodeServeSessionOptions {
  id: string;
  /** Start a server and connect to it: again after one was released or lost. */
  connect(): Promise<OpenCodeConnection>;
  /** A connection already made, used before `connect` is. */
  connected?: OpenCodeConnection;
  directory: string;
  guarantees: Guarantees;
  model?: { providerID: string; id: string };
  permissions?: ReadonlyArray<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>;
  /** The session's MCP servers, so a call on one is put to Barry under Barry's name for it. */
  servers?: readonly string[];
  /** The opencode session to continue rather than start. */
  resumeSessionId?: string;
  decide?(request: PermissionRequest): Promise<PermissionDecision>;
  releaseAfterMs?: number;
  /**
   * Runs once the session has stopped for good: told whether it ever had a
   * conversation (one started on it, or one it resumed).
   */
  onClose?(outcome: { conversation: boolean }): void;
}

interface Link {
  connection: OpenCodeConnection;
  sessionId: string;
}

type TurnEnd = { error: string } | { interrupted: true } | { completed: true };

interface StepTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export class OpenCodeServeSession implements Session {
  readonly mode = "hosted" as const;
  readonly guarantees: Guarantees;

  private version: string | null;
  private openCodeSessionId: string | null = null;
  private link: Promise<Link> | null = null;
  /** The connection events are read from; any other is stale and ignored. */
  private current: OpenCodeConnection | null = null;
  private waitingConnection: OpenCodeConnection | undefined;
  /** A server being stopped. The next one waits for it: stopping is by session id. */
  private stopping: Promise<void> = Promise.resolve();
  private releaseTimer: NodeJS.Timeout | null = null;

  private state: "idle" | "active" | "error" = "idle";
  /** True from a turn's start until its one `done` has been emitted. */
  private turnOpen = false;
  /** Which turn is open, so a late failure cannot end the next one. */
  private turnNumber = 0;
  /** The server has been given the turn's prompt, so an interrupt can reach it. */
  private turnSent = false;
  private interruptWanted = false;
  private lastAnswer = "";
  private steps: StepTotals | null = null;

  private readonly pending: string[] = [];
  private readonly toolNames = new Map<string, string>();
  /** Which opencode session asked each open request: the reply goes there. */
  private readonly askingSessions = new Map<string, string>();
  private readonly buffered: SessionEvent[] = [];
  private readonly waiting: Array<(next: IteratorResult<SessionEvent>) => void> = [];
  private closed = false;
  private messageCount = 0;
  private readonly options: OpenCodeServeSessionOptions;

  constructor(options: OpenCodeServeSessionOptions) {
    this.options = options;
    this.guarantees = { ...options.guarantees };
    this.waitingConnection = options.connected;
    this.version = options.connected?.version ?? null;
  }

  get id(): string {
    return this.options.id;
  }

  get harnessSessionId(): string | null {
    return this.openCodeSessionId ?? this.options.resumeSessionId ?? null;
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
   * A message at idle starts a turn. Mid-turn it steers when asked to and the
   * server has the turn; otherwise it waits for the turn to end.
   *
   * A turn that cannot start ends with an error event rather than a
   * rejection here: the events are where a turn's outcome is read.
   */
  async deliver(content: string, options: DeliveryOptions = {}): Promise<DeliveryReceipt> {
    if (this.closed) throw new Error(`session ${this.options.id} is closed`);
    const messageId = `${this.options.id}-msg-${++this.messageCount}`;
    if (!this.turnOpen) {
      this.beginTurn(content);
      return { messageId, status: "started" };
    }
    if (options.ifActive === "steer" && this.turnSent && this.current && this.link) {
      const { connection, sessionId } = await this.link;
      try {
        await connection.client.prompt(sessionId, content, "steer");
        return { messageId, status: "steered" };
      } catch {
        // The turn ended between the check and the call. Its message is not lost.
        if (!this.turnOpen) {
          this.beginTurn(content);
          return { messageId, status: "started" };
        }
      }
    }
    this.pending.push(content);
    return { messageId, status: "queued" };
  }

  async interrupt(): Promise<void> {
    if (!this.turnOpen) return;
    // Asked before the server has the turn: sent once it does.
    if (!this.turnSent || !this.link || !this.current) {
      this.interruptWanted = true;
      return;
    }
    const number=this.turnNumber;
    const { connection, sessionId } = await this.link;
    if(!this.closed && this.turnOpen && this.turnNumber===number)await connection.client.interrupt(sessionId);
  }

  async answer(request: PermissionRequest, decision: PermissionDecision): Promise<void> {
    // A subagent's request is answered on the subagent's own session.
    const sessionId = this.askingSessions.get(request.id) ?? this.openCodeSessionId;
    this.askingSessions.delete(request.id);
    const connection = this.current;
    if (!sessionId || !connection) return;
    // The first answer wins across clients; losing the race to an attached
    // TUI is expected, not a failure.
    await connection.client.replyPermission(sessionId, request.id, permissionReply(decision)).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.cancelRelease();
    this.pending.length = 0;
    // The turn's reader is owed its end even when the session goes first.
    if (this.turnOpen) this.endTurn({ interrupted: true });
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) resolve({ done: true, value: undefined });
    const connection = this.current;
    this.current = null;
    this.link = null;
    if (connection) this.stopEngine(connection);
    // The server started with the session waits here until its first message,
    // and a session closed before one left it running.
    const waiting = this.waitingConnection;
    this.waitingConnection = undefined;
    if (waiting) this.stopEngine(waiting);
    await this.stopping;
    this.options.onClose?.({ conversation: this.openCodeSessionId !== null || this.options.resumeSessionId !== undefined });
  }


  private linked(): Promise<Link> {
    this.link ??= this.openLink().catch((err: unknown) => {
      this.link = null;
      throw err;
    });
    return this.link;
  }

  private async openLink(): Promise<Link> {
    await this.stopping;
    const connection = this.waitingConnection ?? (await this.options.connect());
    this.waitingConnection = undefined;
    if (this.closed) {
      this.stopEngine(connection);
      throw new Error(`session ${this.options.id} is closed`);
    }
    this.current = connection;
    if (connection.version) this.version = connection.version;
    void this.read(connection);
    try {
      return { connection, sessionId: await this.openSession(connection) };
    } catch (err) {
      if (this.current === connection) {
        this.current = null;
        this.stopEngine(connection);
      }
      throw err;
    }
  }

  /** Create the opencode session, or take up the one this session already has. */
  private async openSession(connection: OpenCodeConnection): Promise<string> {
    const known = this.openCodeSessionId ?? this.options.resumeSessionId;
    let id: string;
    if (known) {
      // Its rules are set again: a session from before this server may not ask.
      await connection.client.setPermissions(known, this.options.permissions ?? ASK_EVERY_CALL);
      id = known;
    } else {
      id = await connection.client.createSession({
        directory: this.options.directory,
        ...(this.options.model ? { model: this.options.model } : {}),
        permissions: this.options.permissions ?? ASK_EVERY_CALL,
      });
    }
    if (this.openCodeSessionId === null) {
      this.openCodeSessionId = id;
      this.emit({ type: "init", harnessSessionId: id });
    }
    return id;
  }

  /** Read the server's events until its stream ends — which, unasked, means the server went. */
  private async read(connection: OpenCodeConnection): Promise<void> {
    try {
      for await (const raw of connection.events) {
        if (this.current !== connection) return;
        const event = serveEventOf(raw);
        if (event) this.onServerEvent(connection, event);
      }
    } catch {
      // The stream failing is the connection ending; handled below.
    }
    this.onConnectionLost(connection);
  }

  private onConnectionLost(connection: OpenCodeConnection): void {
    if (this.current !== connection) return;
    this.current = null;
    this.link = null;
    this.stopEngine(connection);
    if (this.turnOpen) this.endTurn({ error: "the opencode server went away during the turn" });
  }

  private stopEngine(connection: OpenCodeConnection): void {
    connection.close();
    const previous = this.stopping;
    this.stopping = previous.then(() => connection.engine.stop()).catch(() => undefined);
  }

  private scheduleRelease(): void {
    const after = this.options.releaseAfterMs;
    if (!after || this.closed) return;
    this.cancelRelease();
    this.releaseTimer = setTimeout(() => this.release(), after);
    this.releaseTimer.unref();
  }

  private cancelRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  /**
   * Let the server go while nothing needs it; the next delivery starts another.
   * A turn that began after the timer was set keeps it.
   */
  private release(): void {
    this.releaseTimer = null;
    const connection = this.current;
    if (this.turnOpen || this.closed || !connection) return;
    this.current = null;
    this.link = null;
    this.stopEngine(connection);
  }


  /** Open a turn now, so a delivery arriving meanwhile queues behind it. */
  private beginTurn(content: string): void {
    const number = this.openTurn();
    void this.sendTurn(number, content);
  }

  private openTurn(): number {
    this.turnOpen = true;
    this.turnSent = false;
    this.interruptWanted = false;
    this.lastAnswer = "";
    this.steps = null;
    this.state = "active";
    return ++this.turnNumber;
  }

  private async sendTurn(number: number, content: string): Promise<void> {
    try {
      const { connection, sessionId } = await this.linked();
      // `queue`, not the server's default of steering: a turn someone else
      // started on this server (an attached TUI) is not Barry's to redirect.
      await connection.client.prompt(sessionId, content, "queue");
      if (this.turnNumber !== number || !this.turnOpen) return;
      this.turnSent = true;
      if (this.interruptWanted) {
        this.interruptWanted = false;
        await connection.client.interrupt(sessionId);
      }
    } catch (err) {
      if (this.turnNumber === number && this.turnOpen) this.endTurn({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  private onServerEvent(connection: OpenCodeConnection, event: ServeEvent): void {
    // The server is this session's alone, so every request on it is this
    // session's to rule on — its subagents' too. They run in child sessions,
    // and an unanswered request there holds the parent's turn forever.
    if (event.type === "permission.asked") {
      void this.rule(connection, event);
      return;
    }
    // Everything else is read from this session alone: a subagent's own turn
    // ending is not this one's.
    if (sessionOf(event) !== this.openCodeSessionId) return;
    switch (event.type) {
      case "session.execution.started":
        // A turn someone else started (a TUI attached to this server) is
        // still a turn: it opens here so it ends here, with its one `done`.
        if (!this.turnOpen) {
          this.openTurn();
          this.turnSent = true;
        }
        this.emit({ type: "status", status: "active" });
        return;
      case "session.execution.succeeded":
        if (this.turnOpen) this.endTurn({ completed: true });
        return;
      case "session.execution.failed":
        if (this.turnOpen) this.endTurn({ error: messageOf(event.data.error) ?? "opencode turn failed" });
        return;
      case "session.execution.interrupted":
        if (this.turnOpen) this.endTurn({ interrupted: true });
        return;
      case "session.tool.input.started":
        if (typeof event.data.id === "string" && typeof event.data.name === "string") this.toolNames.set(event.data.id, event.data.name);
        return;
    }
    const tokens = stepTokensOf(event);
    if (tokens && this.turnOpen) {
      const sum = this.steps ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      this.steps = {
        input: sum.input + tokens.input,
        output: sum.output + tokens.output,
        cacheRead: sum.cacheRead + tokens.cacheRead,
        cacheWrite: sum.cacheWrite + tokens.cacheWrite,
        cost: sum.cost + tokens.cost,
      };
      return;
    }
    for (const item of itemEvents(event, this.toolNames)) {
      if (item.type === "text") this.lastAnswer = item.text;
      this.emit(item);
    }
  }

  /**
   * Close the open turn with its one `done`, after a `result` for a turn that
   * ran — the result is where a turn's usage is recorded — and then start
   * whatever queued behind it.
   */
  private endTurn(end: TurnEnd): void {
    const usage = this.usageOfTurn();
    const events: SessionEvent[] = [];
    if ("error" in end) events.push({ type: "error", error: end.error });
    else if ("completed" in end) events.push({ type: "result", ...(this.lastAnswer ? { result: this.lastAnswer } : {}) });
    events.push({ type: "done", ...(usage ? { usage } : {}) });

    this.turnOpen = false;
    this.turnSent = false;
    this.interruptWanted = false;
    this.steps = null;
    this.state = "error" in end ? "error" : "idle";
    this.emit({ type: "status", status: this.state });
    for (const event of events) this.emit(event);

    const next = this.pending.shift();
    if (next !== undefined && !this.closed) this.beginTurn(next);
    else this.scheduleRelease();
  }

  private usageOfTurn(): TokenUsage | undefined {
    const steps = this.steps;
    if (!steps) return undefined;
    return {
      inputTokens: steps.input,
      outputTokens: steps.output,
      totalTokens: steps.input + steps.output,
      cacheReadTokens: steps.cacheRead,
      cacheWriteTokens: steps.cacheWrite,
      ...(steps.cost > 0 ? { costUsd: steps.cost } : {}),
    };
  }


  /**
   * Every request is answered: an unanswered one holds the call, and the turn,
   * forever. With no ruling to ask, the call is refused.
   */
  private async rule(connection: OpenCodeConnection, event: ServeEvent): Promise<void> {
    const request = permissionOf(event, this.options.servers);
    if (!request || this.current !== connection) return;
    const asking = sessionOf(event);
    if (asking) this.askingSessions.set(request.id, asking);
    this.emit({ type: "permission_request", ...request });
    const decision: PermissionDecision = this.options.decide
      ? await this.options.decide(request).catch(() => ({ allow: false, reason: "the ruling on this call failed" }))
      : { allow: false, reason: "no ruling available for this session" };
    await this.answer(request, decision);
  }

  private emit(event: SessionEvent): void {
    if (this.closed) return;
    const resolve = this.waiting.shift();
    if (resolve) resolve({ done: false, value: event });
    else this.buffered.push(event);
  }
}

/** A model ref as opencode names models: its vendor, then the rest. */
function modelOf(ref: string): { providerID: string; id: string } | undefined {
  const slash = ref.indexOf("/");
  return slash > 0 ? { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) } : undefined;
}

async function waitUntilReady(client: OpenCodeServerClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`opencode server did not become ready within ${timeoutMs}ms`);
}

/**
 * How long after its MCP servers connect a server's tool registry has them.
 *
 * A server reports a connection `connected` once its tools are listed, then
 * rebuilds the registry a request's tools come from on an event of its own,
 * and nothing it serves says when that is done. On 2.0.24 a request sent 110ms
 * after the listing went without them and one sent 430ms after had them; the
 * margin is the price of a first turn that has Barry's tools.
 */
const MCP_SETTLE_MS = 1000;

/**
 * Wait until each of the session's MCP servers has connected or failed in its
 * directory, then for the registry to take their tools in. Past the deadline
 * the session goes on without the ones still pending: a turn missing a tool
 * is better than no turn.
 */
async function waitForMcpServers(
  client: Pick<OpenCodeServerClient, "mcpStatus">,
  servers: readonly string[],
  directory: string,
  timeoutMs: number,
  settleMs: number,
): Promise<void> {
  if (servers.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await client.mcpStatus(directory).catch((): Record<string, string> => ({}));
    if (servers.every((name) => status[name] !== undefined && status[name] !== "pending")) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
