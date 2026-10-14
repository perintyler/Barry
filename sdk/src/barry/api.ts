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
  Schedule,
  Scheduler,
  OneOffQuery,
  Bag,
  BarryEvent,
  Change,
  Delivery,
  Device,
  EventInput,
  EventQuery,
  Grants,
  GrantSelection,
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
  OneOff,
  OneOffInput,
  Owner,
  Service,
  Session,
  SessionQuery,
  SessionStart,
  SessionUpdate,
  Skill,
  Tool,
  Trait,
  Updated,
} from "./types.js";

/**
 * Many of something. Iterate it to go through every item, fetching pages as
 * needed (`for await (const s of bux.sessions())`), or await it for them all
 * at once (`const all = await bux.sessions()`).
 */
export interface Collection<T> extends AsyncIterable<T>, PromiseLike<T[]> {}

/** What you can ask Barry: one Barry, as one caller. */
export interface Barry {
  identities(): Collection<Identity>;
  identity(ref: IdentityReference): IdentityHandle;
  createIdentity(input: IdentityCreate): Promise<Updated<Identity>>;
  traits(): Promise<Trait[]>;
  bounds(): Promise<Bound[]>;
  /** What a session of no identity is granted, given what it selects (a schedule that names only traits). */
  grants(selection?: GrantSelection): Promise<Grants>;
  bags(): Promise<Bag[]>;
  bag(name: string): BagHandle;
  actions(): Promise<Action[]>;
  action(name: string): ActionHandle;
  events(query?: EventQuery): Collection<BarryEvent>;
  recordEvent(input: EventInput): Promise<BarryEvent>;
  /** The latest recorded change to each file, naming the session that made it when the caller may see that session. */
  lastChanges(paths: readonly string[]): Promise<Change[]>;
  schedules(): Promise<Schedule[]>;
  scheduler(): Promise<Scheduler>;
  schedule(id: string): ScheduleHandle;
  oneOff(id: string): OneOffHandle;
  oneOffs(query?: OneOffQuery): Promise<OneOff[]>;
  scheduleOnce(input: OneOffInput): Promise<OneOff>;
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
  /** The traits it carries, inherited ones included. */
  traits(): Promise<Trait[]>;
  /** What a session of it would be granted, given what the session selects on top. */
  grants(selection?: GrantSelection): Promise<Grants>;
  /** The tools a session of it would start with. */
  tools(selection?: GrantSelection): Promise<Tool[]>;
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
  /** Everything the session is granted, in one call. */
  grants(): Promise<Grants>;
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
  /** This bag's store, from code running inside Barry (a tool, a job, a script). */
  store(name?: string): StoreBinding;
  tools(): Promise<Tool[]>;
  extensions(): Promise<string[]>;
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

export interface OneOffHandle {
  readonly id: string;
  cancel(): Promise<OneOff>;
}
