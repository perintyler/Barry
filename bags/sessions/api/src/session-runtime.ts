import {envMs} from "@barry-rocks/sdk/sessions";
import { PersistQueue } from "./runtime/persist-queue.js";
import { TurnTimer } from "./runtime/turn-timer.js";
import {type McpServerConfig, type Session, type SessionAttachment, type SessionConfig as HarnessSessionConfig, type SessionEvent, type PermissionRequest, type PermissionDecision} from "@barry-rocks/sdk/sessions";
import type { AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import {authorizeSessionExecution} from "@barry-rocks/sessions-bag/execution-authorization";
import {ResidentBudget, TurnSemaphore, admissionLimitsFromEnvironment, type AdmissionLimits, type Reservation} from "./execution-admission.js";

import {type TurnEvent} from "./turn-events.js";
import type { CreateSessionFn } from "./agent-runtime-types.js";

/** What the runtime does with a client's socket: check it is open, and send to it. */
export interface SessionSubscriber { readonly readyState: number; send(data: string): void; publish?(data: string, onSent: () => void): boolean }
// Static, from the light subpath: the capability table is a types-only leaf,
// so reading it costs nothing and no longer needs the dynamic import that
// existed only to keep the agent SDKs off this module's load path.
import {Events} from "@barry-rocks/events-bag";
import {markCrashedSessions} from "@barry-rocks/sessions-bag/client";
import {createLogger} from "@barry-rocks/sdk/logging";
import {InboxRelay} from "./inbox-relay.js";

import {hostname} from "node:os";
import {classify} from "@barry-rocks/sessions-bag/process-liveness";
import {getServiceUrl} from "@barry-rocks/sdk/services";

export { buildMcpConfig } from "./mcp-config.js";

/** The MCP engine, looked up per call so a moved engine is reached on the next request. */
export const engineUrl = (): string => getServiceUrl("mcpBarry");

/** Who a running session's grants are asked as: the runtime acts for its sessions with the installation's authority. */

export interface BagAuthStatus {
  scoped: boolean;
  bags: string[];
}

/** Bags the MCP server reports as unauthorized — OAuth never done, or expired. */
export async function getBagsNeedingAuth(sessionId?: string): Promise<BagAuthStatus> {
  try {
    const secret = process.env.BARRY_SECRET;
    const headers: Record<string, string> = {};
    if (secret) headers.Authorization = `Bearer ${secret}`;
    const url = sessionId
      ? `${engineUrl()}/bag-status?sessionId=${encodeURIComponent(sessionId)}`
      : `${engineUrl()}/bag-status`;
    // Timed: this runs after the resident slot is reserved and the row is
    // flipped to running, so an un-timed fetch here hangs the start path on the
    // engine. A timeout is the existing failure branch (scoped: false).
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { scoped: false, bags: [] };
    const status = await res.json() as { needsAuth?: string[]; authExpired?: string[]; scoped?: boolean };
    const bags = [...(status.needsAuth ?? []), ...(status.authExpired ?? [])];
    return { scoped: status.scoped !== false, bags };
  } catch {
    return { scoped: false, bags: [] };
  }
}

export function buildBagAuthGuidance(bags: string[]): string {
  return [
    "## Bag Authorization",
    "",
    `The following bags need OAuth authorization before their tools are available: ${bags.join(", ")}.`,
    "When you need tools from these bags, call the `bag_auth` MCP tool with the bag name",
    `(e.g. bag_auth({ bag: "${bags[0]}" })). This opens one browser tab for the user to authorize,`,
    "waits for completion, and reconnects the bag's tools. Then retry your original request.",
  ].join("\n");
}

/**
 * Tell the user — not just the agent — that a bag this session wants is
 * unauthorized.
 *
 * The system-prompt guidance above only helps once the agent tries a tool and
 * notices it is missing. Recording an event surfaces it immediately: it rides
 * the bus to any connected client, and BarryEvents turns it into a native
 * notification whose click starts the OAuth flow.
 *
 * `data.action` is what makes the notification actionable — clients route on it
 * rather than pattern-matching the title.
 */
export async function recordBagAuthEvent(sessionId: string, bags: string[]): Promise<void> {
  try {
    await Events.create({
      type: "system_alert",
      session_id: sessionId,
      source: "api",
      title: bags.length === 1
        ? `${bags[0]} needs authorization`
        : `${bags.length} bags need authorization: ${bags.join(", ")}`,
      body: "Their tools are unavailable until you authorize them.",
      severity: "warn",
      data: { action: "bag_auth", bags },
    });
  } catch (err) {
    // Never fail session start over a notification.
    log.warn("bags.auth_event_failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const log = createLogger("session-runtime");

import type { Bound } from "@barry-rocks/sdk/bounds";

export type { McpServerConfig };

export interface SessionConfig {
  ingressAt?: number;
  sessionId?: string; // Optional - will be created if not provided
  prompt: string;
  repoPath: string;
  name?: string;
  bags?: string[];
  bounds?: Array<Bound | string>;
  bound?: Bound | null;
  mcpServers?: Record<string, McpServerConfig>;
  continueFromSessionId?: string;
  metadata?: Record<string, unknown>;
  identityId?: number | null;
  useWorktree?: boolean;
  provider?: string; // Agent provider: 'claude' (default), 'codex', etc.
  model?: string; // Model override (provider-specific, e.g. 'o4-mini')
  /** Model provider (z.ai, Ollama) to route to, independent of the model id. */
  modelProvider?: string;
  clientMessageId?: string;
  reuseClientMessageRow?: boolean;
  userMessageSequence?: number;
  initialHistoryContext?: string;
  /** Prepare resources without accepting a user message or starting a harness. */
  prepareOnly?: boolean;
}

export interface ActiveSession {
  turnControl?: {force:AbortController;done:Promise<void>;finish:()=>void};
  finalization?:Promise<void>;
  lastEventAt?:string;
  lastEventAtMonotonic?:number;
  /** Startup and latest-turn durations, in milliseconds. */
  timings: Record<string, number>;
  turnTimer?: TurnTimer;
  warming: Promise<void> | null;
  warmGeneration?: number;
  warm: { preparedAt?: number; idleSince?: number; error?: string } | null;
  id: string;
  sessionId: string | null;
  prompt: string;
  repoPath: string;
  name: string;
  status: "starting" | "streaming" | "waiting" | "complete" | "error";
  subscribers: Set<SessionSubscriber>;
  session: Session | null; // The hosted session, created at the first turn
  /** The hosted session while it is being created, so concurrent callers share one. */
  opening: Promise<Session> | null;
  /** TUIs attached to the hosted session, by attachment id, each held for the process that launched it. */
  renderers: Map<string, Launcher>;
  /** Tools changed while a TUI was attached; the session reopens with them once the last one leaves. */
  toolsChangedWhileAttached: boolean;
  /**
   * The TUI mode this conversation ran in before the runtime took it over —
   * its driver gone, a message arrived. Its first open is an adoption; set to
   * null once opened, since from then on it is hosted.
   */
  adoptedFrom: string | null;
  abortController: AbortController | null;
  /**
   * The running turn's controller was aborted to END THE TURN, not the
   * session: it rests as a finished turn does, rather than as a stopped one.
   */
  interruptedTurn: AbortController | null;
  outputBuffer: string;
  acceptedMessages?: Map<string, string>;
  persistence?: PersistQueue<WsMessage>;
  statePersistence?: PersistQueue<null>;
  recordingLagSources?: Set<string>;
  turnFrames?: WsMessage[];
  replaying?: Map<SessionSubscriber, WsMessage[]>;
  thinkingBuffer?: string;
  startedAtRecorded?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  promptCacheTtl?: "5m" | "1h";
  identityEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * The sequence of the last message this runtime stored and sent for the
   * session (-1: none), which a new subscriber is told. Starts from the store's
   * highest, so a restarted session reports the history it already has.
   */
  lastSequence: number;
  mcpServers: Record<string, McpServerConfig>;
  createdAt: Date;
  unlisted: boolean;
  identityId: number | null;
  identityName: string | null;
  bags: string[];
  bounds: Array<Bound | string>;
  bound: Bound | null;
  consecutiveFailures: number;
  provider: string;
  model?: string;
  /** Where the model is served, when not the agent's own endpoint. */
  modelProvider?: string;
  /** System-prompt guidance collected from active bags' `instructions` fields. */
  bagInstructions?: string;
  /**
   * The actions index. Already included in bagInstructions for providers that
   * honor systemPrompt; held separately so codex/opencode — which ignore
   * systemPrompt entirely — can receive it as a prompt prefix instead.
   */
  actionsIndex?: string;
  /**
   * On-demand instruction index and always-on instruction bodies. Both are
   * already in bagInstructions for providers that honour systemPrompt; held
   * separately so codex/opencode — which ignore it entirely — get them as a
   * prompt prefix instead.
   */
  instructionsIndex?: string;
  alwaysInstructions?: string;
  /** Whether the prompt-prefix providers have already received the prose bag. */
  actionsIndexSent?: boolean;
  /** Skills dirs from the barry's enabled bags (mounted alongside trait-granted skills). */
  bagSkillsDirs: string[];
  /** Bag names enabled for this session, for per-turn slash-command scoping. */
  bagNames: string[];
  /** Temp Claude Code plugin dir holding this session's mounted skills. Removed on session end. */
  skillsPluginDir: string | null;
  /** Temp project root of generated slash commands (cursor only). Removed on session end. */
  commandsDir: string | null;
  workflowScoped?: boolean;
  // Serializes turns for this session. A CodingAgentSession cannot safely run
  // two concurrent send() loops, so runSession() chains onto this promise so a
  // second sendMessage() waits for the in-flight turn to finish.
  turnQueue: Promise<void>;
  /** Most recently admitted turn, for explicit callers that own its result. */
  lastTurn: Promise<SessionTurnOutcome> | null;
  pendingTurns: number;
  /**
   * Bumped by stopSession/removeSession before anything else they do
   *. A turn captures the generation it was queued under;
   * if the generation has moved by the time that turn's own turnQueue link
   * fires, runTurn returns immediately instead of running — which is what
   * stops a stop-during-queue from resurrecting the session via a fresh
   * `createSession` call. Also checked after semaphore acquisition (stop can
   * land while a turn is queued waiting for an execution slot) and after the
   * provider's event loop ends (late events must not update status or persist).
   */
  generation: number;
  /** Invalidates queued turns without closing this session or staling an active turn. */
  interruptGeneration: number;
}

/** The process that launched an attached TUI; the attachment lasts while it runs. */
export interface Launcher {
  pid: number;
  /** Unix seconds, so a recycled pid is not mistaken for the launcher. */
  startedAt: number;
}

/** What a TUI needs to show a session, and the id that ends its attachment. */
export interface RendererAttachment extends SessionAttachment {
  attachmentId: string;
}

/** Terminal outcome for one serialized harness turn, before any workflow receipt is committed. */
export type SessionTurnOutcome =
  | { state: "completed"; result: string | null }
  | { state: "interrupted" | "stopped" }
  | { state: "failed"; error: string };

// WebSocket message types
export interface WsMessage {
  dedupeKey?: string;
  createdAt?: string;
  type: string;
  sessionId?: string;
  content?: string;
  name?: string;
  input?: unknown;
  result?: string;
  status?: string;
  error?: string;
  role?: "user" | "assistant" | "system";
  lastEventAt?:string|null;
  toolUseId?: string;
  elapsedTime?: number;
  sequence?: number;
  protocolVersion?: number;
  capabilities?: {
    streaming: boolean;
    thinking?: boolean;
    activity?: boolean;
    gating: boolean;
    listener: boolean;
    attachments: boolean;
  };
  requestId?: string;
  tool?: string;
  timeoutMs?: number;
  /**
   * Set when this came from a subagent rather than the main thread, carrying
   * the id of the Task tool call that spawned it. Lets the transcript, the UI,
   * and the summarizer tell nested work from the agent's own output.
   */
  parentToolUseId?: string;
  metadata?: Record<string, unknown>;
  messageId?: string;
  clientMessageId?: string;
  deliveryState?: "queued" | "accepted" | "failed" | "uncertain";
  deliveryError?: string | null;
  reuseClientMessageRow?: boolean;
  sessions?: Array<{
    id: string;
    sessionId: string | null;
    name?: string;
    repoPath: string;
    status: string;
    createdAt: string;
  }>;
}

export class RunnerExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerExecutionError";
  }
}

export interface SessionRuntimeDeps {
  /**
   * Overrides the installed agent runtime — the seam a fake provider is
   * injected through in tests. Unset, the factory comes from
   * `setAgentRuntime()`, which the service entry point calls at boot.
   */
  createSession?: CreateSessionFn;
  limits?: Partial<AdmissionLimits>;
  /** Whether an attached TUI's launcher still runs; injected so a test can end one. */
  launcherRunning?: (launcher: Launcher) => boolean;
  /** How often attachments are checked for a launcher that died without detaching. */
  launcherCheckMs?: number;
}

export class SessionRuntime {
  /** Detached residents retain durability ownership until their FIFO drains. */
  readonly drainingSessions = new Map<string, ActiveSession>();
  retainPersistence(active: ActiveSession): void {
    if(this.drainingSessions.get(active.id)===active)return;
    if(!active.persistence?.pending().length && !active.statePersistence?.pending().length && !active.finalization)return;
    this.drainingSessions.set(active.id, active);
    const drain = async () => {
      while (!await this.flushPersistence(active.id, 1000)) { /* keep retrying without dropping accepted rows */ }
      await active.finalization;
      if(active.finalization || active.recordingLagSources?.size){
        active.recordingLagSources?.clear();
        this.sendInTurn(active,{type:"status",sessionId:active.id,status:active.status,metadata:{code:"persistence_recovered",recordingDelayed:false}});
      }
      if (this.drainingSessions.get(active.id) === active) this.drainingSessions.delete(active.id);
    };
    void drain().catch(error => log.error("session.drain_failed", {sessionId:active.id,error:String(error)}));
  }
  async forceTurn(active: ActiveSession): Promise<void> {
    const control=active.turnControl;
    const silentMs=active.lastEventAtMonotonic===undefined?0:Math.max(0,performance.now()-active.lastEventAtMonotonic);
    active.generation++;
    active.interruptGeneration++;
    active.abortController?.abort();
    control?.force.abort();
    const session=active.session;
    active.session=null; active.warm=null; active.warming=null; active.opening=null; active.warmGeneration=(active.warmGeneration??0)+1;
    active.thinkingBuffer=""; active.outputBuffer=""; active.turnFrames=[];
    if(session) void session.close().catch(error=>log.warn("session.force_close_failed",{sessionId:active.id,error:String(error)}));
    if(control) await control.done;
    active.status="waiting";
    this.sendInTurn(active,{type:"status",sessionId:active.id,status:"waiting",metadata:{code:"turn_forced",silentMs}});
  }

  public executionGuard?: (sessionId: string) => boolean;
  setExecutionGuard(guard: (sessionId: string) => boolean): void { this.executionGuard = guard; }
  acquireTurnSlot(): Promise<{ release(): void }> { return this.turnSemaphore.acquire(); }
  public activeSessions: Map<string, ActiveSession> = new Map();
  /**
   * Startups in progress, keyed by session id — see `startSession`. Entries
   * live only for the duration of one `startSessionUncoordinated` call; a
   * session that finished starting is in `activeSessions`, not here.
   */
  public startingSessions: Map<string, Promise<ActiveSession>> = new Map();
  /**
   * Tail of each session's outbound chain — see `inTurn`. A message the store
   * keeps is appended before it is sent, and everything broadcast after it
   * waits its turn: events are written in the order they were broadcast, which
   * tool_start/tool_result correlation depends on, and sent in the order the
   * store numbered them.
   */
  public outboxes: Map<string, Promise<void>> = new Map();
  public crashSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Long-polls the inbox for sessions resting here — see startInboxRelay. */
  public inboxRelay: InboxRelay | null = null;
  /**
   * Provenance of the runner event currently being handled, applied to anything
   * broadcast while it is set. Safe as a single field because handleRunnerEvent
   * awaits one event at a time per turn and turns are serialized by turnQueue;
   * it saves and restores the previous value so nesting cannot leak.
   */
  public currentProvenance: string | undefined;
  public toolTimers: Map<string, { start: number; name: string; sessionId: string }> = new Map(); // toolUseId → {start, name, sessionId}
  /**
   * Resident-session and turn-execution admission.
   *
   * Two independent budgets — see execution-admission.ts's module doc
   * comment. `residentBudget` replaces the old `maxSessions` field plus
   * `getRunningSessionCount()`'s await-gapped check; `turnSemaphore` bounds
   * how many turns actively stream through a provider at once, including
   * resumes (acquired inside runTurn, which every execution path funnels
   * through).
   */
  public readonly residentBudget: ResidentBudget;
  private readonly turnSemaphore: TurnSemaphore;
  public readonly createSessionOverride?: CreateSessionFn;
  public admissionChain: Promise<void> = Promise.resolve();
  public readonly launcherRunning: (launcher: Launcher) => boolean;
  public readonly launcherCheckMs: number;
  public launcherCheck: ReturnType<typeof setInterval> | null = null;
  /** Hosted sessions whose turns from other clients are already being recorded. */
  public readonly recordingExternalTurns = new WeakSet<Session>();

  constructor(deps: SessionRuntimeDeps = {}) {
    const limits = { ...admissionLimitsFromEnvironment(), ...deps.limits };
    this.residentBudget = new ResidentBudget(limits.maxResidentSessions);
    this.turnSemaphore = new TurnSemaphore(limits.maxConcurrentTurns, limits.maxQueuedTurns);
    this.createSessionOverride = deps.createSession;
    this.launcherRunning = deps.launcherRunning ?? ((launcher) =>
      classify({ pid: launcher.pid, pid_started_at: launcher.startedAt, hostname: hostname() }).state !== "dead");
    this.launcherCheckMs = deps.launcherCheckMs ?? 30_000;
  }

  async reconcileStaleSessions(): Promise<void> { return rt_reconcileStaleSessions(this); }

  /** Ids of sessions currently held open in memory (streaming or resting between turns). */
  getActiveSessionIds(): string[] {
    return [...this.activeSessions.keys()];
  }

  /**
   * Periodically close sessions whose process died without cleaning up.
   *
   * reconcileStaleSessions only runs at boot, so a session that crashes between
   * restarts keeps claiming to be live indefinitely. Sessions still held in
   * memory are excluded, so a healthy long-lived session is never reaped no
   * matter how long it has been idle.
   */
  // 24h idle, checked hourly. Measured against real history: sessions routinely
  // sit idle and then resume — 163 sessions had a >1h gap mid-session and kept
  // working, and 30 gaps exceeded 24h. The in-memory exclusion is the primary
  // guard, so this threshold only has to be long enough that a session which
  // outlived its process is unambiguously dead. Shorter values were tried and
  // would have closed sessions that were merely paused.
  private warmSweepTimer: ReturnType<typeof setInterval> | null = null;
  warmHarness(sessionId: string): Promise<void> { return rt_warmHarness(this, sessionId); }
  dropResident(sessionId: string, options: { force?: boolean } = {}): Promise<ActiveSession | null> { return rt_dropResident(this, sessionId, options); }
  async sweepWarmSessions(): Promise<void> {
    const idleMs = envMs("BARRY_WARM_IDLE_MS",15*60_000);
    for (const active of this.activeSessions.values()) {
      const since = active.warm?.idleSince ?? active.warm?.preparedAt;
      if (since === undefined || active.lastSequence >= 0 || active.pendingTurns || active.abortController || active.warming || active.renderers.size || active.subscribers.size) continue;
      if (Date.now() - since >= idleMs) await this.stopSession(active.id);
    }
  }
  startWarmSweep(intervalMs = 60_000): void {
    if (this.warmSweepTimer) return;
    this.warmSweepTimer = setInterval(() => { void this.sweepWarmSessions().catch(error => log.warn("session.warm_sweep_failed", { error: String(error) })); }, intervalMs);
    this.warmSweepTimer.unref?.();
  }
  stopWarmSweep(): void { if (this.warmSweepTimer) clearInterval(this.warmSweepTimer); this.warmSweepTimer = null; }

  startCrashedSessionSweep(intervalMs = 60 * 60 * 1000, idleMs = 24 * 60 * 60 * 1000): void {
    if (this.crashSweepTimer) return;
    const sweep = async () => {
      try {
        const reaped = await markCrashedSessions(idleMs, this.getActiveSessionIds());
        if (reaped > 0) {
          log.info("reconcile.crashed_sessions", { reaped, idleMs });
          this.broadcastSessionList();
        }
      } catch (err) {
        log.warn("reconcile.crash_sweep_error", { error: err instanceof Error ? err.message : String(err) });
      }
    };
    // unref so a pending sweep never holds the process open during shutdown.
    this.crashSweepTimer = setInterval(sweep, intervalMs);
    this.crashSweepTimer.unref?.();
    void sweep();
  }

  stopCrashedSessionSweep(): void {
    if (this.crashSweepTimer) {
      clearInterval(this.crashSweepTimer);
      this.crashSweepTimer = null;
    }
  }

  /**
   * Watch the inbox on behalf of sessions that are idle here.
   *
   * A running turn drains its own inbox when it ends; an idle session has
   * nothing that will run again on its own, so without this a message waits
   * for a human. Registering the `runtime` listener is also what lets
   * `send_prompt` report `wake` — the claim is only made while this is running.
   */
  startInboxRelay(): void {
    if (this.inboxRelay) return;
    this.inboxRelay = new InboxRelay({
      idleSessionIds: () =>
        [...this.activeSessions.values()]
          .filter((session) => session.status === "waiting" && session.pendingTurns === 0)
          .map((session) => session.id),
      deliver: (sessionId, content) => this.sendMessage(sessionId, content),
    });
    this.inboxRelay.start();
  }

  async stopInboxRelay(): Promise<void> {
    const relay = this.inboxRelay;
    this.inboxRelay = null;
    await relay?.stop();
  }

  public async recordSessionDeclaration(sessionId: string, harness: string, session: Session, adoptedFrom: string | null = null): Promise<void> { return rt_recordSessionDeclaration(this, sessionId, harness, session, adoptedFrom); }

  /**
   * Start a session, coordinating concurrent starts for the SAME session id.
   *
   * Two messages arriving for one inactive session used to each run a full,
   * independent `startSession`: both reserved resident capacity, both built an
   * ActiveSession, and the second's `activeSessions.set(id, …)` displaced the
   * first. The displaced object then failed `isStale`'s map-identity check, so
   * its turn — the FIRST user's message — silently never ran, while the
   * orphaned reservation stayed committed (ResidentBudget.commit overwrites
   * bySessionId, so `releaseById` on stop could only free one of the two).
   *
   * Coordination is keyed by session id, so only a start for an EXISTING
   * session can be joined; a create (no `config.sessionId`) mints its own id
   * and has nothing to collide with. The second caller awaits the first's
   * startup and then delivers its own prompt as a follow-up turn, which is
   * what keeps its message from disappearing.
   */
  async startSession(config: SessionConfig, principal?: AuthPrincipal): Promise<ActiveSession> {
    if (principal) principal = await authorizeSessionExecution(principal, config);
    if (!config.prepareOnly && config.sessionId && this.executionGuard?.(config.sessionId)) throw new Error("Session has an active durable turn");
    const key = config.sessionId;
    if (!key) return this.startSessionUncoordinated(config, principal);

    const inFlight = this.startingSessions.get(key);
    if (inFlight) {
      // Someone else is already starting this session. Wait for the startup
      // itself, then hand this call's prompt to the same session as a
      // follow-up turn — it chains onto turnQueue behind the cold-start turn.
      //
      // NOT awaited to completion: `startSession` resolves once the session is
      // resident (its own first turn runs fire-and-forget via
      // `void this.runSession(...)`), so a joining caller that blocked until
      // its turn's provider stream ended would hang the request — and, with a
      // single-slot turn semaphore, deadlock against the very turn it is
      // queued behind.
      const activeSession = await inFlight;
      if (!config.prepareOnly) void this.sendMessage(key, config.prompt, {ingressAt:config.ingressAt,clientMessageId:config.clientMessageId,reuseClientMessageRow:config.reuseClientMessageRow,userMessageSequence:config.userMessageSequence,initialHistoryContext:config.initialHistoryContext}, principal).catch((err) => {
        log.error("session.joined_start_message_failed", {
          sessionId: key,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return activeSession;
    }

    const started = this.startSessionUncoordinated(config, principal);
    // Registered synchronously, before the first await above can yield: a
    // second caller entering startSession in the same tick must already see
    // this entry, or it would start its own competing session.
    this.startingSessions.set(key, started);
    try {
      return await started;
    } finally {
      this.startingSessions.delete(key);
    }
  }

  /** Start a newly admitted session turn and wait for that exact turn's terminal outcome. */
  async startSessionAndWait(config: SessionConfig, principal?: AuthPrincipal): Promise<{ session: ActiveSession; outcome: SessionTurnOutcome }> {
    const session = await this.startSession(config, principal);
    const turn = session.lastTurn;
    if (!turn) throw new Error("session startup did not admit a harness turn");
    return { session, outcome: await turn };
  }

  public async startSessionUncoordinated(config: SessionConfig, principal?: AuthPrincipal): Promise<ActiveSession> { return rt_startSessionUncoordinated(this, config, principal); }

  public async reserveResidentSession(): Promise<Reservation> { return rt_reserveResidentSession(this); }

  public runSession(
    activeSession: ActiveSession,
    prompt: string,
    mcpServers: Record<string, McpServerConfig>,
    ingressAt?: number,
  ): Promise<SessionTurnOutcome> { return rt_runSession(this, activeSession, prompt, mcpServers, ingressAt); }

  public withActionsIndex(activeSession: ActiveSession, prompt: string): string { return rt_withActionsIndex(this, activeSession, prompt); }

  public turnWasStopped(activeSession: ActiveSession, controller: AbortController, gen: number): boolean { return rt_turnWasStopped(this, activeSession, controller, gen); }

  public isStale(activeSession: ActiveSession, gen: number): boolean { return rt_isStale(this, activeSession, gen); }

  public async resolveHarnessEnvironment(activeSession: ActiveSession): Promise<Record<string, string | undefined>> { return rt_resolveHarnessEnvironment(this, activeSession); }

  async prepareHarnessConfiguration(
    activeSession: ActiveSession,
    mcpServers: Record<string, McpServerConfig> = activeSession.mcpServers,
    suppliedEnv?: Record<string, string | undefined>,
    interactive = true,
  ): Promise<HarnessSessionConfig> { return rt_prepareHarnessConfiguration(this, activeSession, mcpServers, suppliedEnv, interactive); }

  async authorizeContinuationTool(sessionId: string, request: PermissionRequest): Promise<PermissionDecision> { return rt_authorizeContinuationTool(this, sessionId, request); }

  public ensureHarnessSession(
    activeSession: ActiveSession,
    mcpServers: Record<string, McpServerConfig> = activeSession.mcpServers,
    env?: Record<string, string | undefined>,
  ): Promise<Session> { return rt_ensureHarnessSession(this, activeSession, mcpServers, env); }

  public async openHarnessSession(
    activeSession: ActiveSession,
    mcpServers: Record<string, McpServerConfig>,
    env?: Record<string, string | undefined>,
  ): Promise<Session> { return rt_openHarnessSession(this, activeSession, mcpServers, env); }

  public async runTurn(
    activeSession: ActiveSession,
    prompt: string,
    mcpServers: Record<string, McpServerConfig>,
    gen: number,
    interruptGen: number,
    timer?: TurnTimer,
  ): Promise<SessionTurnOutcome> { return rt_runTurn(this, activeSession, prompt, mcpServers, gen, interruptGen, timer); }

  public sweepToolTimers(sessionId: string): void { return rt_sweepToolTimers(this, sessionId); }

  public turnEvents(session: Session, prompt: string, stopped: () => boolean, force?:AbortSignal, onEvent?:()=>void): AsyncGenerator<TurnEvent> { return rt_turnEvents(this, session, prompt, stopped, force, onEvent); }

  public async handleRunnerEvent(activeSession: ActiveSession, event: TurnEvent): Promise<void> { return rt_handleRunnerEvent(this, activeSession, event); }

  public async handleRunnerEventInner(activeSession: ActiveSession, event: TurnEvent): Promise<void> { return rt_handleRunnerEventInner(this, activeSession, event); }

  public createDecideFunction(
    activeSession: ActiveSession,
    deniedTools: readonly string[],
    servers: readonly string[],
    allowedNativeTools: readonly string[],
  ): (request: PermissionRequest) => Promise<PermissionDecision> { return rt_createDecideFunction(this, activeSession, deniedTools, servers, allowedNativeTools); }

  async prepareTurnAttachments(activeSession: ActiveSession, attachmentIds: string[]): Promise<string> { return rt_prepareTurnAttachments(this, activeSession, attachmentIds); }

  private async materializeAndFormatAttachments(
    activeSession: ActiveSession,
    attachmentIds: string[],
  ): Promise<string> { return rt_materializeAndFormatAttachments(this, activeSession, attachmentIds); }

  async sendMessage(
    sessionId: string,
    content: string,
    options: { ingressAt?: number; clientMessageId?: string; reuseClientMessageRow?: boolean; userMessageSequence?: number; initialHistoryContext?: string; attachmentIds?: string[] } = {},
    principal?: AuthPrincipal,
  ): Promise<void> { return rt_sendMessage(this, sessionId, content, options, principal); }

  async sendMessageAndWait(sessionId: string, content: string, workflowTurnId: string): Promise<SessionTurnOutcome> { return rt_sendMessageAndWait(this, sessionId, content, workflowTurnId); }

  public async enqueueMessage(
    sessionId: string,
    content: string,
    options: { ingressAt?: number; clientMessageId?: string; reuseClientMessageRow?: boolean; userMessageSequence?: number; initialHistoryContext?: string; attachmentIds?: string[]; workflowTurnId?: string },
    waitForTurn: boolean,
  ): Promise<SessionTurnOutcome | undefined> { return rt_enqueueMessage(this, sessionId, content, options, waitForTurn); }

  publishPersistenceHealth(sessionId:string,source:string,lagging:boolean):void {
    const active=this.activeSessions.get(sessionId);if(!active)return;
    const sources=active.recordingLagSources??=new Set<string>();
    if(lagging)sources.add(source);else sources.delete(source);
    const recordingDelayed=sources.size>0;
    this.sendInTurn(active,{type:"status",sessionId,status:active.status,metadata:{code:recordingDelayed?"persistence_lagging":"persistence_recovered",recordingDelayed}});
  }
  allocateSequence(sessionId:string):number {const active=this.activeSessions.get(sessionId);if(!active)throw new Error("Session is not resident");return ++active.lastSequence;}
  flushPersistence(sessionId: string, timeoutMs=1000): Promise<boolean> {
    const active=this.activeSessions.get(sessionId)??this.drainingSessions.get(sessionId);
    return Promise.all([active?.persistence?.flush(timeoutMs)??true,active?.statePersistence?.flush(timeoutMs)??true]).then(results=>results.every(Boolean));
  }
  async drainPersistence(timeoutMs=30_000): Promise<boolean> {
    return PersistQueue.drainAll(timeoutMs);
  }
  pendingPersistence(sessionId: string): WsMessage[] { return (this.activeSessions.get(sessionId)??this.drainingSessions.get(sessionId))?.persistence?.pending() ?? []; }
  assertPersistenceAdmission(sessionId: string): void { PersistQueue.assertGlobalAdmission(); this.activeSessions.get(sessionId)?.persistence?.assertAdmission(); }
  subscribe(sessionId: string, ws: SessionSubscriber, _options?: { protocolVersion?: number; afterSequence?: number }): void { return rt_subscribe(this, sessionId, ws, _options); }

  unsubscribe(sessionId: string, ws: SessionSubscriber): void { return rt_unsubscribe(this, sessionId, ws); }

  unsubscribeAll(ws: SessionSubscriber): void { return rt_unsubscribeAll(this, ws); }

  async interruptTurn(sessionId: string, principal?: AuthPrincipal): Promise<boolean> { return rt_interruptTurn(this, sessionId, principal); }

  async attachRenderer(sessionId: string, launcherPid: number, principal?: AuthPrincipal): Promise<RendererAttachment> { return rt_attachRenderer(this, sessionId, launcherPid, principal); }

  async detachRenderer(sessionId: string, attachmentId: string, principal?: AuthPrincipal): Promise<boolean> { return rt_detachRenderer(this, sessionId, attachmentId, principal); }

  public releaseRenderer(activeSession: ActiveSession, attachmentId: string): void { return rt_releaseRenderer(this, activeSession, attachmentId); }

  public checkLaunchers(): void { return rt_checkLaunchers(this); }

  public async recordExternalTurns(activeSession: ActiveSession, session: Session): Promise<void> { return rt_recordExternalTurns(this, activeSession, session); }

  async stopSession(sessionId: string, principal?: AuthPrincipal, reason: "stopped" | "evicted" = "stopped"): Promise<void> { return rt_stopSession(this, sessionId, principal, reason); }

  async removeSession(sessionId: string, principal?: AuthPrincipal): Promise<void> { return rt_removeSession(this, sessionId, principal); }

  invalidateSessionTools(sessionId: string, options: {reason?: "grants" | "system_prompt"} = {}): void { return rt_invalidateSessionTools(this, sessionId, options); }

  getActiveSession(sessionId: string): ActiveSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  getActiveSessions(): ActiveSession[] {
    return Array.from(this.activeSessions.values());
  }

  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  publishDeliveryUpdate(
    sessionId: string,
    update: {
      messageId: string;
      clientMessageId?: string;
      deliveryState: "queued" | "accepted" | "failed" | "uncertain";
      deliveryError?: string | null;
    },
  ): void { return rt_publishDeliveryUpdate(this, sessionId, update); }

  public broadcastToSession(sessionId: string, message: WsMessage): void { return rt_broadcastToSession(this, sessionId, message); }

  public sendInTurn(activeSession: ActiveSession, message: WsMessage, append?: () => Promise<number | null>): void { return rt_sendInTurn(this, activeSession, message, append); }

  public inTurn(sessionId: string, send: () => void, store?: () => Promise<void>): void { return rt_inTurn(this, sessionId, send, store); }

  broadcastSessionList(ws?: SessionSubscriber): void { return rt_broadcastSessionList(this, ws); }

  public sendToClient(ws: SessionSubscriber, message: WsMessage): void { return rt_sendToClient(this, ws, message); }
}

export const sessionRuntime = new SessionRuntime();

/** Read and discard the rest of an interrupted turn. */
export async function drainTurn(reader: AsyncIterator<{ type: string }>): Promise<void> {
  for (;;) {
    const next = await reader.next();
    if (next.done || next.value.type === "done") return;
  }
}

/**
 * A turn's events without the messages a person typed, which go to `typed`:
 * the runtime reads every text as the agent's, and a typed one is the user's.
 */
export async function* typedMessagesApart(events: AsyncIterable<SessionEvent>, typed: (text: string) => void): AsyncGenerator<SessionEvent> {
  for await (const event of events) {
    if (event.type === "text" && event.role === "user") typed(event.text);
    else yield event;
  }
}

/** The TUI mode a stored session ran in, if it ran in one: what a takeover adopts from. */
export function tuiModeOf(metadata: Record<string, unknown> | null | undefined): string | null {
  const mode = metadata?.mode;
  return mode === "guest" || mode === "instrumented" || mode === "guest-plus" ? mode : null;
}

// Delegated method bodies (split for file size; see ./runtime/*).
import {rt_recordSessionDeclaration, rt_startSessionUncoordinated, rt_reserveResidentSession} from "./runtime/start.js";
import { rt_warmHarness, rt_dropResident } from "./runtime/warm.js";
import {rt_resolveHarnessEnvironment, rt_prepareHarnessConfiguration, rt_authorizeContinuationTool, rt_ensureHarnessSession, rt_openHarnessSession} from "./runtime/harness.js";
import {rt_runSession, rt_withActionsIndex, rt_turnWasStopped, rt_isStale, rt_runTurn, rt_sweepToolTimers, rt_turnEvents, rt_handleRunnerEvent, rt_handleRunnerEventInner, rt_createDecideFunction} from "./runtime/turn.js";
import {rt_attachRenderer, rt_detachRenderer, rt_releaseRenderer, rt_checkLaunchers, rt_recordExternalTurns} from "./runtime/renderers.js";
import {rt_reconcileStaleSessions, rt_stopSession, rt_removeSession, rt_invalidateSessionTools} from "./runtime/lifecycle.js";
import {rt_subscribe, rt_unsubscribe, rt_unsubscribeAll, rt_interruptTurn, rt_publishDeliveryUpdate, rt_broadcastToSession, rt_sendInTurn, rt_inTurn, rt_broadcastSessionList, rt_sendToClient} from "./runtime/outbox.js";
import {rt_prepareTurnAttachments, rt_materializeAndFormatAttachments, rt_sendMessage, rt_sendMessageAndWait, rt_enqueueMessage} from "./runtime/messages.js";
