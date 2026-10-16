/**
 * The objects `Barry` hands out. Each is what a person would recognise:
 * an identity, a session, a tool it can call. None of them is a storage row,
 * MCP plumbing, or `identity.yaml`'s spelling; the bags map their records to
 * these. The ones that cross HTTP reuse the schemas the API already validates
 * with (`./identities/types`, `./sessions/types`, `./events`), so a client
 * and a server agree on every field.
 */
import type { z } from "zod";
import type { Bound } from "../bounds/types.js";
import type { ApiWarning } from "../errors.js";
import type { BarryEvent } from "../events/index.js";
import type { IdentitySchema, BagInfoSchema } from "../identities/types.js";
import type { MessageSchema, Session } from "../sessions/types.js";
import type { AtScheduleRecord } from "../schedules/types.js";
import type { JobRunRecord } from "../jobs/types.js";
import type { SecretReference } from "../identities/secrets.js";
import type { IdentityBagConfiguration } from "../identities/bags.js";

import type { AdapterSettings } from "../identities/adapters.js";
export type { AdapterSettings, IdentityAdapters } from "../identities/adapters.js";

export type { Session, BarryEvent, Bound };

/** An identity: reusable configuration a session runs as. */
export type Identity = z.infer<typeof IdentitySchema>;
/** One message in a session's transcript. */
export type Message = z.infer<typeof MessageSchema>;
/** A bag as the registry knows it. */
export type Bag = z.infer<typeof BagInfoSchema>;
/** An action scheduled to run once, later. */
export type AtSchedule = AtScheduleRecord;
/** One run of a bag's job. */
export type JobRun = JobRunRecord;
/** A non-fatal condition reported beside a successful change. */
export type Warning = ApiWarning;

/** A value a change produced, with the warnings it raised. */
export type Updated<T> = T & { readonly warnings: readonly Warning[] };

/** How an identity is named in a call: its name, or its row id. */
export type IdentityReference = string | number;

import type { ToolContext } from "../tools/define-tool.js";

/** A tool a session can call. */
export interface Tool {
  id?: string;
  unavailable?: string;
  uncontrolled?: string;
  /** The tool's own name, as the harness calls it. */
  name: string;
  /** The namespace it is granted under (`git`, `linear`, `bash`). */
  namespace: string;
  /** The bag that provides it; null for a harness's own tool. */
  bag: string | null;
  /** What it does, when its bag says. */
  description?: string;
  access: "read" | "write";
  /** JSON Schema of its input, when known. */
  input?: Record<string, unknown>;
  /** Declared network capabilities for tool-level bound filtering. */
  network?: string[];
  /** Input schema map for path/parameter guard inspection. */
  schema?: Readonly<Record<string, unknown>>;
  /** In-process guarded tool handler when loaded directly. */
  handler?: (params: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
}

/** A skill a session has mounted. */
export interface Skill {
  name: string;
}

/** An instruction document a session is pointed at. */
export interface Instruction {
  name: string;
}

/** A change to an identity. A field that is present is changed; `null` clears it. */
export interface IdentityUpdate {
  adapters?: Readonly<Record<string, AdapterSettings>> | null;
  displayName?: string | null;
  bags?: readonly string[] | null;
  bagConfigs?: Readonly<Record<string, IdentityBagConfiguration>> | null;
  bounds?: readonly string[] | null;
  statusNotify?: { tool: string; target?: string } | null;
  githubInstallationId?: number | null;
  vault?: string | null;
  secrets?: Readonly<Record<string, SecretReference>> | null;
  /** More commands that run Barry as this identity. */
  aliases?: readonly string[] | null;
}

/** What creating an identity takes. */
export interface IdentityCreate extends IdentityUpdate {
  name: string;
  /** Where its directory goes; by default Barry's own identities folder. */
  directory?: string;
  inherits?: string;
}

/** What removing an identity did. */
export interface IdentityRemoval {
  name: string;
  sessionsDeleted: number;
  /** A directory in Barry's own folder is moved aside; one recorded elsewhere is unregistered and left on disk. */
  directory: "moved" | "unregistered" | null;
  movedTo?: string;
  /** The identity that became the default, null when none remain, undefined when the default did not change. */
  nextDefault: string | null | undefined;
}

/** What starting a session takes. */
export interface SessionStart {
  prompt?: string;
  systemPrompt?: string;
  repoPath?: string;
  name?: string;
  bags?: readonly string[];
  harness?: string;
  model?: string;
  modelVendor?: string;
  modelProvider?: string;
  bounds?: readonly (Bound | string)[];
  bound?: Bound | null;
  useWorktree?: boolean;
}

/** A change to a session's own settings. */
export interface SessionUpdate {
  name?: string;
  bags?: readonly string[];
  pinned?: boolean;
  bounds?: readonly (Bound | string)[];
  bound?: Bound | null;
  harness?: string;
  model?: string;
  modelVendor?: string;
  modelProvider?: string;
}

/** What `session.send` reports about a message. */
export interface Delivery {
  state: "queued" | "accepted" | "failed" | "uncertain";
  messageId?: string;
  clientMessageId?: string | null;
}

/** One file change a session made, as the tracker recorded it. */
export interface Change {
  /** The session that made it; null when that session belongs to an identity the caller may not see. */
  sessionId: string | null;
  path: string;
  at: string;
  tool: string | null;
}

/** An action a session or a caller can run. */
export interface Action {
  name: string;
  qualifiedName: string;
  bag: string;
  description: string;
  /** Whether it can run detached through the actions API. */
  executable: boolean;
  inputs: string[];
  inputSchema?: Record<string, unknown>;
}

export interface ActionWorkReference {
  workId: string; workflowId: string; owner: string; revision: number;
  state: "queued" | "running" | "waiting" | "waiting-for-approval" | "stopping" | "needs-attention" | "completed" | "failed" | "cancelled";
  current: boolean; stopProtocol?: "work-stop-v1"; url?: string;
}
/** One run of an action. */
export interface ActionRun {
  id: string;
  action: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "abandoned" | "queued" | "waiting" | "waiting-for-approval" | "stopping" | "needs-attention";
  work?: ActionWorkReference;
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  output?: unknown;
  error?: string;
}

/** A launchd-managed service of a bag. */
export interface Service {
  key: string;
  bag: string;
  name: string;
  kind: "service" | "app" | "container" | "deployment";
  state: "starting" | "running" | "backoff" | "stopped" | "conflict" | "unsupported";
  registered: boolean;
  enabled: boolean;
  system: boolean;
  pid: number | null;
  port: number | null;
  address: string | null;
  health: "ok" | "failing" | "unknown";
  restarts: number;
  startedAt: string | null;
  lastExitCode: number | null;
  workingDirectory: string;
  loopbackOnly: boolean | null;
  conflict: string | null;
  problem: string | null;
}

/** A device paired with this Barry. */
export interface Device {
  id: string;
  name: string;
  scopes: string[];
  identityIds: number[];
  pairedAt: string;
  lastSeenAt: string | null;
}

/** The person this installation belongs to. */
export interface Owner {
  id: number;
  name: string;
  defaultIdentity: string | null;
}

/** A query over sessions. */
export interface SessionQuery {
  active?: boolean;
  order?: "created" | "activity";
  status?: Session["status"] | readonly Session["status"][];
  pinned?: boolean;
  search?: string;
  since?: string;
}

/** A query over events. */
export interface EventQuery {
  session?: string;
  type?: BarryEvent["type"];
  unread?: boolean;
  since?: string;
}

/** An event to record. */
export interface EventInput {
  type: BarryEvent["type"];
  title: string;
  body?: string;
  severity?: BarryEvent["severity"];
  session?: string;
  data?: Record<string, unknown>;
}

/** An action to run once, later. */
export interface AtScheduleInput {
  /** Total attempts when a run fails, 1 to 5. Default 1. */
  attempts?: number;
  action: string;
  inputs?: Record<string, unknown>;
  dueAt: string | Date;
  identity?: IdentityReference;
  bags?: readonly string[];
  bounds?: readonly string[];
  idempotencyKey?: string;
}

/** A recurring schedule with its most recent scheduler state. */
export interface Schedule {
  id: string;
  trigger: string;
  action: string;
  job?: string;
  description?: string;
  enabled: boolean;
  paused: boolean;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  lastStatus: string | null;
  lastSummary: string | null;
  lastRunId: string | null;
  consecutiveFailures: number;
  skippedFires: number;
  missedFires: number;
}

export interface Scheduler {
  status: "ok" | "degraded" | "down";
  reason: string | null;
  heartbeatAt: string | null;
  loadErrors: string[];
}

export interface AtScheduleQuery {
  bag?: string;
  status?: AtSchedule["status"];
  limit?: number;
}

export interface ActionRunQuery {
  action?: string;
  schedule?: string;
  limit?: number;
}

/** Which messages to read, and how much detail to carry. */
export interface MessageQuery {
  /** Read oldest first after this sequence. */
  after?: number;
  /** Read newest first before this sequence. */
  before?: number;
  /** Read from the newest message. */
  newestFirst?: boolean;
  /** Carry an input preview and omit results. */
  brief?: boolean;
}
