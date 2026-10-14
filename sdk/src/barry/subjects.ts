/**
 * The subjects Barry answers for, as the bags that own them provide them, and
 * the caller every call carries. A process that hosts a bag installs what it
 * provides with `Barry.use(...)`; every other process reaches the same subject
 * over HTTP. A subject decides what its caller may do: the
 * owner may do anything, a paired device only what its grant names, a session
 * what its identity allows.
 */
import type { AuthPrincipal, DevicePrincipal } from "../auth/principal.js";
import type { SessionEvent } from "./api.js";
import type {
  Action,
  ActionRun,
  ActionRunQuery,
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
  Tool,
  Trait,
  Updated,
} from "./types.js";

/** Who is asking. */
export type Caller =
  /** The installation's owner: the terminal, or a service holding the instance secret. */
  | { readonly kind: "owner"; readonly actorId?: number }
  /** A paired device: its scopes and the identities it was granted, nothing else. */
  | { readonly kind: "device"; readonly principal: DevicePrincipal }
  /** Code running for a session (a bag's tool, a hook): what that session's identity allows. */
  | {
      readonly kind: "session";
      readonly identity: IdentityReference;
      readonly sessionId: string;
      /** The bag asking on this session's behalf, absent when the session itself asks. */
      readonly bag?: string;
    };

const OWNER: Caller = Object.freeze({ kind: "owner" });

/** The caller a verified request carries: its device, or the owner (no principal means the instance secret). */
export function requestCaller(principal: AuthPrincipal | undefined): Caller {
  if (!principal) return OWNER;
  return principal.kind === "device" ? { kind: "device", principal } : { kind: "owner", actorId: principal.actorId };
}

/** One page of a collection, and where the next one starts. */
export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface Identities {
  readonly name: "identities";
  list(caller: Caller): Promise<Identity[]>;
  get(ref: IdentityReference, caller: Caller): Promise<Identity>;
  create(input: IdentityCreate, caller: Caller): Promise<Updated<Identity>>;
  update(ref: IdentityReference, changes: IdentityUpdate, caller: Caller): Promise<Updated<Identity>>;
  remove(ref: IdentityReference, caller: Caller): Promise<IdentityRemoval>;
  makeDefault(ref: IdentityReference, caller: Caller): Promise<void>;
  /** The traits the identity carries, inherited ones included. */
  traits(ref: IdentityReference, caller: Caller): Promise<Trait[]>;
  /** What a session of the identity (or of none, for `null`) is granted. */
  grants(ref: IdentityReference | null, selection: GrantSelection, caller: Caller): Promise<Grants>;
  /** Every trait and named bound this installation has. */
  allTraits(caller: Caller): Promise<Trait[]>;
  bounds(caller: Caller): Promise<Bound[]>;
  owner(caller: Caller): Promise<Owner>;
  devices(caller: Caller): Promise<Device[]>;
  revokeDevice(id: string, caller: Caller): Promise<void>;
}

export interface Sessions {
  readonly name: "sessions";
  list(identity: IdentityReference, query: SessionQuery, cursor: string | null, caller: Caller): Promise<Page<Session>>;
  get(identity: IdentityReference, id: string, caller: Caller): Promise<Session>;
  start(identity: IdentityReference, input: SessionStart, caller: Caller): Promise<Session>;
  update(identity: IdentityReference, id: string, changes: SessionUpdate, caller: Caller): Promise<Session>;
  grants(identity: IdentityReference, id: string, caller: Caller): Promise<Grants>;
  messages(identity: IdentityReference, id: string, query: MessageQuery, cursor: string | null, caller: Caller): Promise<Page<Message>>;
  message(identity: IdentityReference, id: string, sequence: number, caller: Caller): Promise<Message>;
  listening(identity: IdentityReference, id: string, caller: Caller): Promise<boolean>;
  events(identity: IdentityReference, id: string, caller: Caller): AsyncIterable<SessionEvent>;
  send(identity: IdentityReference, id: string, text: string, options: { clientMessageId?: string }, caller: Caller): Promise<Delivery>;
  end(identity: IdentityReference, id: string, caller: Caller): Promise<void>;
  archive(identity: IdentityReference, id: string, caller: Caller): Promise<void>;
  /** Delete every session of an identity, as removing the identity does; how many there were. */
  removeAll(identity: IdentityReference, caller: Caller): Promise<number>;
}

export interface Actions {
  readonly name: "actions";
  list(caller: Caller): Promise<Action[]>;
  /** The actions a session can run. */
  forSession(identity: IdentityReference, sessionId: string, caller: Caller): Promise<Action[]>;
  run(name: string, inputs: Record<string, unknown>, options: { identity?: IdentityReference }, caller: Caller): Promise<ActionRun>;
  runs(query: ActionRunQuery, caller: Caller): Promise<ActionRun[]>;
}

export interface Events {
  readonly name: "events";
  list(query: EventQuery, cursor: string | null, caller: Caller): Promise<Page<BarryEvent>>;
  record(input: EventInput, caller: Caller): Promise<BarryEvent>;
}

export interface Schedules {
  readonly name: "schedules";
  list(caller: Caller): Promise<Schedule[]>;
  scheduler(caller: Caller): Promise<Scheduler>;
  oneOffs(query: OneOffQuery, caller: Caller): Promise<OneOff[]>;
  scheduleOnce(input: OneOffInput, caller: Caller): Promise<OneOff>;
  cancelOneOff(id: string, caller: Caller): Promise<OneOff>;
}

export interface Bags {
  readonly name: "bags";
  list(caller: Caller): Promise<Bag[]>;
  tools(bag: string, caller: Caller): Promise<Tool[]>;
  extensions(bag: string, caller: Caller): Promise<string[]>;
  runJob(bag: string, job: string, inputs: Record<string, unknown>, options: { key?: string; identity?: IdentityReference }, caller: Caller): Promise<JobRun>;
}

export interface Tracker {
  readonly name: "tracker";
  lastChanges(paths: readonly string[], caller: Caller): Promise<Change[]>;
  changes(identity: IdentityReference, sessionId: string, caller: Caller): Promise<Change[]>;
}

export interface Services {
  readonly name: "services";
  list(caller: Caller): Promise<Service[]>;
  get(key: string, caller: Caller): Promise<Service>;
  start(key: string, caller: Caller): Promise<Service>;
  stop(key: string, caller: Caller): Promise<Service>;
  restart(key: string, caller: Caller): Promise<Service>;
}

/** A subject Barry answers for, as a bag provides it: what `Barry.use` installs. */
export type Subject =
  | Identities
  | Sessions
  | Actions
  | Events
  | Schedules
  | Bags
  | Tracker
  | Services;

export type SubjectName = Subject["name"];
export type SubjectNamed<N extends SubjectName> = Extract<Subject, { name: N }>;
