/**
 * The `Barry` object: one surface, two ways to reach a subject. A process
 * that hosts a bag installs what it provides (`Barry.use`), and calls run
 * in-process; any other process connects (`Barry.connect`), and the same calls
 * go over HTTP. With neither, a call fails loudly instead of guessing.
 *
 * Browser-safe on purpose (the SDK root is bundled for browsers): the ambient
 * caller comes from a resolver the hosting process installs (`Barry.useCaller`),
 * not from Node's async context here.
 */
import { defineTool } from "../tools/define-tool.js";
import { bagBinding } from "../bags/store.js";
import { BarryClient } from "../client/platypus.js";
import type { BarryClientOptions } from "../client/http.js";
import type { StoreBinding } from "../stores/bindings.js";
import { BarryError } from "./errors.js";
import {
  defineBound,
  defineStore,
  resolveBarryActions,
  resolveBarryBound,
  resolveBarryInstructions,
  resolveBarrySkills,
  resolveBarryTools,
  type BagLike,
  type BagToolInput,
  type BoundConstructor,
  type IdentityLike,
} from "./resolve.js";
import type {
  ActionHandle,
  BagHandle,
  Barry as BarryQuestions,
  Collection,
  DeviceHandle,
  IdentityHandle,
  JobHandle,
  ServiceHandle,
  ScheduleHandle,
  SessionHandle,
} from "./api.js";
import type { Caller, Page, Subject, SubjectName, SubjectNamed } from "./subjects.js";
import type { Action, Bag, Bound, IdentityReference, Tool } from "./types.js";
import { overHttp } from "./http.js";

interface Runtime {
  installed: Map<SubjectName, Subject>;
  connection: BarryClient | null;
  callerResolver: (() => Caller | undefined) | null;
}

const RUNTIME = Symbol.for("barry.runtime.v1");

// Bundled bags carry another SDK copy, but share their host's installation.
function runtime(): Runtime {
  const shared = globalThis as Record<symbol, unknown>;
  return (shared[RUNTIME] ??= {
    installed: new Map<SubjectName, Subject>(),
    connection: null,
    callerResolver: null,
  }) as Runtime;
}

const OWNER: Caller = Object.freeze({ kind: "owner" });

interface ScopeOptions {
  /** A connection only this scope uses (`Barry.at`). */
  client?: BarryClient;
  /** The caller this scope acts as (`Barry.as`); otherwise the ambient one. */
  caller?: Caller;
}

function subject<N extends SubjectName>(name: N, options: ScopeOptions): SubjectNamed<N> {
  if (options.client) return overHttp(options.client, name);
  const { installed, connection } = runtime();
  const local = installed.get(name) as SubjectNamed<N> | undefined;
  if (local) return local;
  if (connection) return overHttp(connection, name);
  throw new BarryError(
    "unavailable",
    `Nothing answers for ${name} in this process`,
    "A process that hosts Barry installs its bags with Barry.use(...); anything else calls Barry.connect({ baseUrl, secret }) first",
  );
}

function callerOf(options: ScopeOptions): Caller {
  return options.caller ?? runtime().callerResolver?.() ?? OWNER;
}

/** Iterate pages lazily, or await every item at once. */
function collection<T>(page: (cursor: string | null) => Promise<Page<T>>): Collection<T> {
  const iterate = async function* (): AsyncGenerator<T> {
    let cursor: string | null = null;
    do {
      const next: Page<T> = await page(cursor);
      yield* next.items;
      cursor = next.next;
    } while (cursor);
  };
  const all = async (): Promise<T[]> => {
    const items: T[] = [];
    for await (const item of iterate()) items.push(item);
    return items;
  };
  return {
    [Symbol.asyncIterator]: iterate,
    then: (resolve, reject) => all().then(resolve, reject),
  };
}

function whole<T>(items: () => Promise<T[]>): Collection<T> {
  return collection(async () => ({ items: await items(), next: null }));
}

function sessionHandle(identity: IdentityHandle, id: string, options: ScopeOptions): SessionHandle {
  const sessions = () => subject("sessions", options);
  const who = () => callerOf(options);
  return {
    id,
    identity,
    get: async () => sessions().get(identity.ref, id, who()),
    update: async (changes) => sessions().update(identity.ref, id, changes, who()),
    bags: async () => {
      const subj = sessions();
      return subj.bags ? subj.bags(identity.ref, id, who()) : [];
    },
    bounds: async () => {
      const subj = sessions();
      return subj.bounds ? subj.bounds(identity.ref, id, who()) : [];
    },
    tools: async () => {
      const subj = sessions();
      if (!subj.tools) throw new BarryError("unavailable", "sessions.tools is not implemented");
      return subj.tools(identity.ref, id, who());
    },
    skills: async () => {
      const subj = sessions();
      return subj.skills ? subj.skills(identity.ref, id, who()) : [];
    },
    instructions: async () => {
      const subj = sessions();
      return subj.instructions ? subj.instructions(identity.ref, id, who()) : [];
    },
    bound: async () => {
      const subj = sessions();
      return subj.bound ? subj.bound(identity.ref, id, who()) : null;
    },
    actions: async () => {
      const subj = sessions();
      return subj.actions
        ? subj.actions(identity.ref, id, who())
        : subject("actions", options).forSession(identity.ref, id, who());
    },
    messages: (query = {}) => {
      if (query.after !== undefined && (query.before !== undefined || query.newestFirst === true)) {
        throw new BarryError("invalid", "after cannot be combined with before or newestFirst");
      }
      return collection((cursor) => sessions().messages(identity.ref, id, query, cursor, who()));
    },
    message: async (sequence) => sessions().message(identity.ref, id, sequence, who()),
    listening: async () => sessions().listening(identity.ref, id, who()),
    events: () => (async function* () { yield* sessions().events(identity.ref, id, who()); })(),
    send: async (text, sendOptions = {}) => sessions().send(identity.ref, id, text, sendOptions, who()),
    changes: async () => subject("tracker", options).changes(identity.ref, id, who()),
    end: async () => sessions().end(identity.ref, id, who()),
    archive: async () => sessions().archive(identity.ref, id, who()),
  };
}

function identityHandle(ref: IdentityReference, options: ScopeOptions): IdentityHandle {
  const identities = () => subject("identities", options);
  const who = () => callerOf(options);
  const handle: IdentityHandle = {
    ref,
    get: async () => identities().get(ref, who()),
    update: async (changes) => identities().update(ref, changes, who()),
    remove: async () => {
      // Its sessions first, while the identity still resolves. Over HTTP the
      // service removing the identity removes them; in-process the two bags
      // are separate subjects, so the removal is composed here.
      const caller = who();
      const local = !options.client && runtime().installed.has("identities") && runtime().installed.has("sessions");
      const sessionsDeleted = local ? await subject("sessions", options).removeAll(ref, caller) : 0;
      const removal = await identities().remove(ref, caller);
      return local ? { ...removal, sessionsDeleted } : removal;
    },
    makeDefault: async () => identities().makeDefault(ref, who()),
    bags: async () => {
      const subj = identities();
      if (subj.bags) return subj.bags(ref, who());
      const idRecord = await subj.get(ref, who());
      const allBags = await subject("bags", options).list(who());
      return allBags.filter((b) => idRecord.bags.includes(b.name));
    },
    bounds: async () => identities().bounds(who(), ref),
    bound: async (bounds) => {
      const subj = identities();
      if (!subj.bound) throw new BarryError("unavailable", "identities.bound is not implemented");
      return subj.bound(ref, bounds, who());
    },
    tools: async (selection = {}) => {
      const subj = identities();
      if (!subj.tools) throw new BarryError("unavailable", "identities.tools is not implemented");
      return subj.tools(
        ref,
        selection as { bags?: readonly (Bag | string)[]; bounds?: Bound | readonly (Bound | string)[] },
        who(),
      );
    },
    sessions: (query = {}) => collection((cursor) => subject("sessions", options).list(ref, query, cursor, who())),
    session: (id) => sessionHandle(handle, id, options),
    start: async (input = {}) => {
      const started = await subject("sessions", options).start(ref, input, who());
      return sessionHandle(handle, started.id, options);
    },
  };
  return handle;
}

function bagHandle(name: string, options: ScopeOptions): BagHandle {
  const bags = () => subject("bags", options);
  const who = () => callerOf(options);
  const binding = bagBinding(name);
  return {
    name,
    get: async () => {
      const subj = bags();
      if (subj.get) return subj.get(name, who());
      const found = (await subj.list(who())).find((b) => b.name === name);
      if (!found) throw new BarryError("not_found", `Bag "${name}" not found`);
      return found;
    },
    store: (store?: string): StoreBinding => binding.store(store),
    tools: async () => bags().tools(name, who()),
    bounds: async () => {
      const subj = bags();
      return subj.bounds ? subj.bounds(name, who()) : [];
    },
    skills: async () => {
      const subj = bags();
      return subj.skills ? subj.skills(name, who()) : [];
    },
    instructions: async () => {
      const subj = bags();
      return subj.instructions ? subj.instructions(name, who()) : [];
    },
    actions: async () => {
      const subj = bags();
      return subj.actions ? subj.actions(name, who()) : [];
    },
    job: (job): JobHandle => ({
      bag: name,
      name: job,
      run: async (inputs = {}, runOptions = {}) => bags().runJob(name, job, inputs, runOptions, who()),
    }),
  };
}

function scope(options: ScopeOptions): BarryQuestions {
  const who = () => callerOf(options);

  function hasSubject(name: SubjectName): boolean {
    if (options.client) return true;
    const { installed, connection } = runtime();
    return installed.has(name) || connection !== null;
  }

  function toolsImpl<T extends BagToolInput = Tool>(
    identity: IdentityLike | IdentityReference | null | undefined,
    bags?: readonly (Bag | BagLike | T | string)[],
    bounds?: Bound | readonly (Bound | string)[],
    availableBounds?: ReadonlyMap<string, Bound> | Readonly<Record<string, Bound>>,
  ): (Tool & T)[] | Promise<Tool[]> {
    const isRef = typeof identity === "string" || typeof identity === "number";
    const needsSubjectForNull =
      identity === null &&
      availableBounds === undefined &&
      hasSubject("identities") &&
      (bags === undefined || bags.length === 0 || bags.some((b) => typeof b === "string"));
    if (isRef || needsSubjectForNull) {
      const subj = subject("identities", options);
      if (!subj.tools) {
        throw new BarryError("unavailable", "identities.tools is not implemented");
      }
      return subj.tools(
        isRef ? identity : null,
        { bags: bags as readonly (Bag | string)[] | undefined, bounds },
        who(),
      );
    }
    return resolveBarryTools<T>(
      identity,
      (bags ?? []) as readonly (Bag | BagLike | T)[],
      bounds,
      availableBounds,
    );
  }

  function boundImpl(
    identity: IdentityLike | IdentityReference | null | undefined,
    bounds?: readonly (Bound | string)[],
    availableBounds?: ReadonlyMap<string, Bound> | Readonly<Record<string, Bound>>,
  ): Bound | null | Promise<Bound | null> {
    const isRef = typeof identity === "string" || typeof identity === "number";
    const needsSubjectForNull =
      identity === null && availableBounds === undefined && hasSubject("identities");
    if (isRef || needsSubjectForNull) {
      const subj = subject("identities", options);
      if (!subj.bound) {
        throw new BarryError("unavailable", "identities.bound is not implemented");
      }
      return subj.bound(isRef ? identity : null, bounds, who());
    }
    return resolveBarryBound(identity, bounds, availableBounds);
  }

  function skillsImpl(
    identity: IdentityLike | IdentityReference | null | undefined,
    bags?: readonly (Bag | BagLike | string)[],
  ) {
    const isRef = typeof identity === "string" || typeof identity === "number";
    const hasStrBag = bags?.some((b) => typeof b === "string") ?? false;
    if (isRef || hasStrBag) {
      const names = (bags ?? []).map((b) => (typeof b === "string" ? b : b.name));
      return Promise.all(
        names.map((name) =>
          Promise.resolve()
            .then(() => bagHandle(name, options).skills())
            .catch(() => []),
        ),
      ).then((lists) => lists.flat());
    }
    return resolveBarrySkills(identity, (bags ?? []) as readonly (Bag | BagLike)[]);
  }

  function instructionsImpl(
    identity: IdentityLike | IdentityReference | null | undefined,
    bags?: readonly (Bag | BagLike | string)[],
  ) {
    const isRef = typeof identity === "string" || typeof identity === "number";
    const hasStrBag = bags?.some((b) => typeof b === "string") ?? false;
    if (isRef || hasStrBag) {
      const names = (bags ?? []).map((b) => (typeof b === "string" ? b : b.name));
      return Promise.all(
        names.map((name) =>
          Promise.resolve()
            .then(() => bagHandle(name, options).instructions())
            .catch(() => []),
        ),
      ).then((lists) => lists.flat());
    }
    return resolveBarryInstructions(identity, (bags ?? []) as readonly (Bag | BagLike)[]);
  }

  function actionsImpl(
    identity?: IdentityLike | IdentityReference | null,
    bags?: readonly (Bag | BagLike | string)[],
  ): Promise<Action[]> | Action[] {
    if (bags !== undefined) {
      const isRef = typeof identity === "string" || typeof identity === "number";
      const hasStrBag = bags.some((b) => typeof b === "string");
      if (isRef || hasStrBag) {
        const names = bags.map((b) => (typeof b === "string" ? b : b.name));
        return Promise.all(
          names.map((name) =>
            Promise.resolve()
              .then(() => bagHandle(name, options).actions())
              .catch(() => []),
          ),
        ).then((lists) => lists.flat());
      }
      return resolveBarryActions(identity, bags as readonly (Bag | BagLike)[]);
    }
    return subject("actions", options).list(who());
  }

  return {
    tools: toolsImpl as BarryQuestions["tools"],
    bound: boundImpl as BarryQuestions["bound"],
    skills: skillsImpl as BarryQuestions["skills"],
    instructions: instructionsImpl as BarryQuestions["instructions"],
    identities: () => whole(() => subject("identities", options).list(who())),
    identity: (ref) => identityHandle(ref, options),
    createIdentity: async (input) => subject("identities", options).create(input, who()),
    bounds: async (ref) =>
      ref !== undefined
        ? subject("identities", options).bounds(who(), ref)
        : subject("identities", options).bounds(who()),
    bags: async () => subject("bags", options).list(who()),
    bag: (name) => bagHandle(name, options),
    actions: actionsImpl as BarryQuestions["actions"],
    action: (name): ActionHandle => ({
      name,
      run: async (inputs = {}, runOptions = {}) => subject("actions", options).run(name, inputs, runOptions, who()),
      runs: async () => subject("actions", options).runs({ action: name }, who()),
    }),
    events: (query = {}) => collection((cursor) => subject("events", options).list(query, cursor, who())),
    lastChanges: async (paths) => subject("tracker", options).lastChanges(paths, who()),
    recordEvent: async (input) => subject("events", options).record(input, who()),
    schedules: async () => subject("schedules", options).list(who()),
    scheduler: async () => subject("schedules", options).scheduler(who()),
    schedule: (id): ScheduleHandle => ({ id, runs: async () => subject("actions", options).runs({ schedule: id }, who()) }),
    atSchedule: (id) => ({
      id,
      cancel: () => {
        const s = subject("schedules", options);
        const fn = s.cancelAtSchedule;
        if (!fn) throw new BarryError("unavailable", "schedules.cancelAtSchedule is not implemented");
        return fn.call(s, id, who());
      },
    }),
    atSchedules: async (query = {}) => {
      const s = subject("schedules", options);
      const fn = s.atSchedules;
      if (!fn) throw new BarryError("unavailable", "schedules.atSchedules is not implemented");
      return fn.call(s, query, who());
    },
    scheduleAt: async (input) => {
      const s = subject("schedules", options);
      const fn = s.scheduleAt;
      if (!fn) throw new BarryError("unavailable", "schedules.scheduleAt is not implemented");
      return fn.call(s, input, who());
    },
    services: async () => subject("services", options).list(who()),
    service: (key): ServiceHandle => ({
      key,
      get: async () => subject("services", options).get(key, who()),
      start: async () => subject("services", options).start(key, who()),
      stop: async () => subject("services", options).stop(key, who()),
      restart: async () => subject("services", options).restart(key, who()),
    }),
    devices: async () => subject("identities", options).devices(who()),
    device: (id): DeviceHandle => ({ id, revoke: async () => subject("identities", options).revokeDevice(id, who()) }),
    owner: async () => subject("identities", options).owner(who()),
  };
}

/** What you can ask Barry: one Barry, as one caller (what `Barry.at` and `Barry.as` return). */
export type Barry = BarryQuestions;

/** `Barry` itself: what you can ask, and how a process says where the answers come from. */
interface BarryControls extends BarryQuestions {
  /** Define an MCP tool in a bag. */
  Tool: typeof defineTool;
  /** Define and validate a Bound, or merge multiple Bounds via `Barry.Bound.merge(...)`. */
  Bound: BoundConstructor;
  /** Access a bag's store binding inside a Barry execution context. */
  Store: typeof defineStore;
  /** Install the subjects this process hosts; their calls then run in-process. */
  use(...subjects: Subject[]): void;
  /** Forget every installed subject, the connection and the caller resolver (tests). */
  reset(): void;
  /** Reach another Barry over HTTP; only needed where its bags are not installed. */
  connect(options: BarryClientOptions): void;
  /** A second Barry in the same program, over HTTP. */
  at(options: BarryClientOptions): BarryQuestions;
  /** The same questions, asked as this caller. */
  as(caller: Caller): BarryQuestions;
  /** How a hosting process tells Barry who the current call is for. */
  useCaller(resolver: (() => Caller | undefined) | null): void;
}

export const Barry: BarryControls = {
  ...scope({}),
  Tool: defineTool,
  Bound: defineBound,
  Store: defineStore,
  use(...subjects) {
    for (const provided of subjects) runtime().installed.set(provided.name, provided);
  },
  reset() {
    runtime().installed.clear();
    runtime().connection = null;
    runtime().callerResolver = null;
  },
  connect(options) {
    runtime().connection = BarryClient.connect(options);
  },
  at(options) {
    return scope({ client: BarryClient.connect(options) });
  },
  as(caller) {
    return scope({ caller });
  },
  useCaller(resolver) {
    runtime().callerResolver = resolver;
  },
};
