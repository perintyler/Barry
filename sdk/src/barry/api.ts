/**
 * What a caller can ask of Barry, as handles: name a thing once, then ask it
 * questions. A handle is free to make; nothing is fetched until a method is
 * called, and a misspelt name fails on that first call with a `BarryError`.
 * The same calls work in a process that hosts the bags (they run in-process)
 * and anywhere else (they go over HTTP).
 */
import type { StoreBinding } from "../stores/bindings.js";
import type {
  Action,
  ActionRun,
  AtSchedule,
  AtScheduleInput,
  AtScheduleQuery,
  Schedule,
  Scheduler,
  Bag,
  BarryEvent,
  Change,
  Delivery,
  Device,
  EventInput,
  EventQuery,
  Identity,
  IdentityCreate,
  IdentityReference,
  IdentityRemoval,
  IdentityUpdate,
  Instruction,
  JobRun,
  Message,
  MessageQuery,
  Bound,
  Owner,
  Service,
  Session,
  SessionQuery,
  SessionStart,
  SessionUpdate,
  Skill,
  Tool,
  Updated,
} from "./types.js";

import type { BagLike, BagToolInput, IdentityLike } from "./resolve.js";

/**
 * Many of something. Iterate it to go through every item, fetching pages as
 * needed (`for await (const s of bux.sessions())`), or await it for them all
 * at once (`const all = await bux.sessions()`).
 */
export interface Collection<T> extends AsyncIterable<T>, PromiseLike<T[]> {}

/** What you can ask Barry: one Barry, as one caller. */
export interface Barry {
  /**
   * Return the tools for `(identity, bags, boundsOrPinnedBound)` — already filtered by
   * the resolved bound, with `implements` replacements applied, store context bound
   * to `identity`, and each tool's `handler` wrapped with runtime guards.
   *
   * - When `bounds` is an array `(Bound | string)[]` or omitted: resolves
   *   `Barry.bound(identity, bounds)` (merging `identity.bounds` + `bounds`).
   * - When a single already-resolved `Bound` object is passed (e.g. `session.bound`
   *   pinned at session start): uses that pinned `Bound` directly WITHOUT re-reading
   *   live `identity.bounds` from disk, preserving snapshot semantics (§7.1.4).
   */
  tools<T extends BagToolInput = Tool>(
    identity: IdentityLike | null | undefined,
    bags: readonly (Bag | BagLike | T)[],
    bounds?: Bound | readonly (Bound | string)[],
    availableBounds?: ReadonlyMap<string, Bound> | Readonly<Record<string, Bound>>,
  ): (Tool & T)[];
  tools(
    identity: IdentityReference | null | undefined,
    bags?: readonly (Bag | string)[],
    bounds?: Bound | readonly (Bound | string)[],
  ): Promise<Tool[]>;

  /**
   * Fold the identity's non-optional bounds and the given bounds (including
   * `<bag>:read` shorthands) into a single resolved `Bound`.
   */
  bound(
    identity: IdentityLike | null | undefined,
    bounds?: readonly (Bound | string)[],
    availableBounds?: ReadonlyMap<string, Bound> | Readonly<Record<string, Bound>>,
  ): Bound;
  bound(
    identity: IdentityReference | null | undefined,
    bounds?: readonly (Bound | string)[],
  ): Promise<Bound | null>;

  /** Return the skills provided by the identity's bags + the given bags. */
  skills(identity: IdentityLike | null | undefined, bags: readonly (Bag | BagLike)[]): Skill[];
  skills(
    identity: IdentityReference | null | undefined,
    bags?: readonly (Bag | string)[],
  ): Promise<Skill[]>;

  /** Return the instructions provided by the identity's bags + the given bags. */
  instructions(
    identity: IdentityLike | null | undefined,
    bags: readonly (Bag | BagLike)[],
  ): Instruction[];
  instructions(
    identity: IdentityReference | null | undefined,
    bags?: readonly (Bag | string)[],
  ): Promise<Instruction[]>;

  identities(): Collection<Identity>;
  identity(ref: IdentityReference): IdentityHandle;
  createIdentity(input: IdentityCreate): Promise<Updated<Identity>>;
  bounds(identity?: IdentityReference): Promise<Bound[]>;
  bags(): Promise<Bag[]>;
  bag(name: string): BagHandle;
  actions(): Promise<Action[]>;
  actions(identity: IdentityLike | null | undefined, bags: readonly (Bag | BagLike)[]): Action[];
  actions(
    identity: IdentityReference | null | undefined,
    bags: readonly (Bag | string)[],
  ): Promise<Action[]>;
  action(name: string): ActionHandle;
  events(query?: EventQuery): Collection<BarryEvent>;
  recordEvent(input: EventInput): Promise<BarryEvent>;
  /** The latest recorded change to each file, naming the session that made it when the caller may see that session. */
  lastChanges(paths: readonly string[]): Promise<Change[]>;
  schedules(): Promise<Schedule[]>;
  scheduler(): Promise<Scheduler>;
  schedule(id: string): ScheduleHandle;
  atSchedule(id: string): AtScheduleHandle;
  atSchedules(query?: AtScheduleQuery): Promise<AtSchedule[]>;
  scheduleAt(input: AtScheduleInput): Promise<AtSchedule>;
  services(): Promise<Service[]>;
  service(key: string): ServiceHandle;
  devices(): Promise<Device[]>;
  device(id: string): DeviceHandle;
  owner(): Promise<Owner>;
}

export interface IdentityHandle {
  readonly ref: IdentityReference;
  get(): Promise<Identity>;
  update(changes: IdentityUpdate): Promise<Updated<Identity>>;
  /** Remove it: its sessions, its row, and its directory's place in Barry. */
  remove(): Promise<IdentityRemoval>;
  /** Make it the one unqualified commands act as. */
  makeDefault(): Promise<void>;
  /** The bags it packs. */
  bags(): Promise<Bag[]>;
  /** The bounds it carries. */
  bounds(): Promise<Bound[]>;
  /** The resolved bound for this identity plus any additional bounds. */
  bound(bounds?: readonly (Bound | string)[]): Promise<Bound | null>;
  /** The tools a session of it would start with. */
  tools(selection?: {
    bags?: readonly (Bag | string)[];
    bounds?: Bound | readonly (Bound | string)[];
    harness?: string;
    mode?: string;
    defaults?: boolean;
    identityDefaults?: boolean;
  }): Promise<Tool[]>;
  sessions(query?: SessionQuery): Collection<Session>;
  session(id: string): SessionHandle;
  /** Start a session as this identity. */
  start(input?: SessionStart): Promise<SessionHandle>;
}

export interface SessionHandle {
  readonly id: string;
  readonly identity: IdentityHandle;
  get(): Promise<Session>;
  update(changes: SessionUpdate): Promise<Session>;
  bags(): Promise<Bag[]>;
  bounds(): Promise<(Bound | string)[]>;
  tools(): Promise<Tool[]>;
  skills(): Promise<Skill[]>;
  instructions(): Promise<Instruction[]>;
  bound(): Promise<Bound | null>;
  actions(): Promise<Action[]>;
  /** The session's messages, oldest first unless the query asks otherwise. */
  messages(query?: MessageQuery): Collection<Message>;
  /** One message by its sequence. */
  message(sequence: number): Promise<Message>;
  /** Whether a live surface listens or promises delivery. */
  listening(): Promise<boolean>;
  /** The session's live events, as they happen. */
  events(): AsyncIterable<SessionEvent>;
  send(text: string, options?: { clientMessageId?: string }): Promise<Delivery>;
  changes(): Promise<Change[]>;
  end(): Promise<void>;
  archive(): Promise<void>;
}

/** What a live session reports while it runs. */
export type SessionEvent =
  | { type: "message"; message: Message }
  | { type: "status"; status: Session["status"] }
  | { type: "tool"; name: string; phase: "started" | "finished"; isError?: boolean }
  | { type: "ended"; reason?: string };

export interface BagHandle {
  readonly name: string;
  get(): Promise<Bag>;
  /** This bag's store, from code running inside Barry (a tool, a job, a script). */
  store(name?: string): StoreBinding;
  tools(): Promise<Tool[]>;
  bounds(): Promise<Bound[]>;
  skills(): Promise<Skill[]>;
  instructions(): Promise<Instruction[]>;
  actions(): Promise<Action[]>;
  job(name: string): JobHandle;
}

export interface JobHandle {
  readonly bag: string;
  readonly name: string;
  run(inputs?: Record<string, unknown>, options?: { key?: string; identity?: IdentityReference }): Promise<JobRun>;
}

export interface ActionHandle {
  readonly name: string;
  run(inputs?: Record<string, unknown>, options?: { identity?: IdentityReference }): Promise<ActionRun>;
  runs(): Promise<ActionRun[]>;
}

export interface ServiceHandle {
  readonly key: string;
  get(): Promise<Service>;
  start(): Promise<Service>;
  stop(): Promise<Service>;
  restart(): Promise<Service>;
}

export interface DeviceHandle {
  readonly id: string;
  revoke(): Promise<void>;
}

export interface ScheduleHandle {
  readonly id: string;
  runs(): Promise<ActionRun[]>;
}

export interface AtScheduleHandle {
  readonly id: string;
  cancel(): Promise<AtSchedule>;
}
