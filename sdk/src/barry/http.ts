import { identityRequestOf } from "../routes/identities.js";
/**
 * Every subject over HTTP, for a process that does not host its bag: an app,
 * a script, another machine. Built on the routes the services serve today;
 * a question no route answers yet is refused as `unavailable` with what to do
 * instead. B5 generates this from the routes' own schemas.
 */
import type { BarryClient } from "../client/platypus.js";
import { BarryApiError } from "../client/errors.js";
import { BarryError } from "./errors.js";
import type { Caller, SubjectName, SubjectNamed } from "./subjects.js";
import type { ActionEntry, ActionRun as ActionRunRecord } from "../client/actions.js";
import type { Bound } from "../bounds/types.js";
import type { Action, ActionRun, Identity, IdentityReference, Page, Updated } from "./index.js";

function notYet(what: string): never {
  throw new BarryError("unavailable", `${what} is not available over HTTP yet`, "Call it from a process that hosts the bag, which installs it with Barry.use(...)");
}

/** A refusal from a service, as the same error an in-process call throws. */
async function translated<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof BarryApiError)) throw error;
    const reason = error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : error.status === 409 ? "conflict"
      : error.status === 400 || error.status === 422 ? "invalid" : "unavailable";
    throw new BarryError(reason, error.message);
  }
}

async function identityReference(client: BarryClient, ref: IdentityReference): Promise<IdentityReference> {
  if (ref !== "effective" && ref !== "bags") return ref;
  const found = (await translated(() => client.identities.list())).find(identity => identity.name === ref);
  if (!found) throw new BarryError("not_found", `Identity "${ref}" not found`);
  return found.id;
}

async function identityId(client: BarryClient, ref: IdentityReference): Promise<number> {
  if (typeof ref === "number") return ref;
  const found = await translated(async () => client.identities.get(await identityReference(client, ref)));
  if (!found) throw new BarryError("not_found", `Identity "${ref}" not found`);
  return found.id;
}

function withWarnings(result: { identity: Identity; warnings?: Updated<Identity>["warnings"] }): Updated<Identity> {
  return { ...result.identity, warnings: result.warnings ?? [] };
}

/** A bound as a wire body carries it: a plain JSON object. */
function plain(bound: Bound | null | undefined): Record<string, unknown> | null | undefined {
  return bound ? Object.fromEntries(Object.entries(bound)) : bound;
}

function action(entry: ActionEntry): Action {
  const properties = entry.inputSchema?.properties;
  return {
    name: entry.name,
    qualifiedName: entry.qualifiedName,
    bag: entry.bag,
    description: entry.description,
    executable: entry.executable,
    inputs: properties && typeof properties === "object" ? Object.keys(properties) : [],
    ...(entry.inputSchema ? { inputSchema: entry.inputSchema } : {}),
  };
}

function run(record: Pick<ActionRunRecord, "runId" | "action" | "sessionId" | "status" | "startedAt" | "completedAt" | "summary"> & { output?: string | null }): ActionRun {
  const status = record.status === "complete" ? "succeeded" : record.status === "started" ? "running" : record.status === "failed" ? "failed" : "cancelled";
  return {
    id: record.runId,
    action: record.action,
    status,
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    endedAt: record.completedAt,
    summary: record.summary,
    ...(record.output != null ? { output: record.output } : {}),
    ...(status === "failed" && record.summary ? { error: record.summary } : {}),
  };
}

export function overHttp<N extends SubjectName>(client: BarryClient, name: N): SubjectNamed<N> {
  const serviceControl = (operation: "start" | "stop" | "restart", key: string, caller: Caller) => {
    if (caller.kind === "session") throw new BarryError("forbidden", "session service control is unavailable over HTTP");
    return translated(() => client.services[operation](key));
  };
  const subjects: { [K in SubjectName]: SubjectNamed<K> } = {
    identities: {
      name: "identities",
      list: () => translated(() => client.identities.list()),
      get: async (ref) => {
        const found = await translated(async () => client.identities.get(await identityReference(client, ref)));
        if (!found) throw new BarryError("not_found", `Identity ${typeof ref === "number" ? `id ${ref}` : `"${ref}"`} not found`);
        return found;
      },
      create: async (input) => {
        const { name: identityName, directory, inherits, ...changes } = input;
        if (directory !== undefined || inherits !== undefined) notYet("Creating an identity in a chosen directory or with a chosen parent");
        return withWarnings(await translated(() => client.identities.create({ name: identityName, ...identityRequestOf(changes) })));
      },
      update: async (ref, changes) => withWarnings(await translated(async () => client.identities.update(await identityReference(client, ref), identityRequestOf(changes)))),
      remove: async (ref) => {
        const id = await identityReference(client, ref);
        const before = await translated(() => client.identities.get(id));
        const removed = await translated(() => client.identities.remove(id));
        return { name: before?.name ?? String(ref), sessionsDeleted: 0, directory: null, nextDefault: removed.activeIdentity };
      },
      makeDefault: async (ref) => translated(async () => client.identities.setDefault(await identityReference(client, ref))),
      bounds: () => translated(() => client.identities.bounds()),
      owner: () => notYet("The owner"),
      devices: async () => (await translated(() => client.devices.list())).map((device) => ({
        id: device.id, name: device.name, scopes: [...device.scopes], identityIds: [...device.identityIds],
        pairedAt: new Date(device.createdAt).toISOString(), lastSeenAt: device.lastUsedAt === null ? null : new Date(device.lastUsedAt).toISOString(),
      })),
      revokeDevice: (id) => translated(() => client.devices.revoke(id)),
    },
    sessions: {
      name: "sessions",
      list: async (identity, query, cursor) => {
        if (query.since !== undefined && Number.isNaN(Date.parse(query.since))) throw new BarryError("invalid", `since is not a date: ${query.since}`);
        if (query.active === false) notYet("Listing closed sessions");
        const id = await identityId(client, identity);
        const page = await translated(() => client.sessions.list({ identityId: id, ...(query.active === true ? { active: true } : {}), ...(query.order ? { order: query.order === "created" ? "created_at" : "activity" } : {}), ...(cursor ? { cursor } : {}), ...(query.search ? { query: query.search } : {}) }));
        const statuses = typeof query.status === "string" ? [query.status] : query.status;
        const items = page.sessions.filter(session =>
          (statuses === undefined || statuses.includes(session.status)) &&
          (query.pinned === undefined || session.pinned === query.pinned) &&
          (query.since === undefined || Date.parse(session.createdAt) >= Date.parse(query.since)));
        return { items, next: page.nextCursor };
      },
      get: async (_identity, id) => {
        const found = await translated(() => client.sessions.get(id));
        if (!found) throw new BarryError("not_found", `Session ${id} not found`);
        return found;
      },
      start: async (identity, input) => {
        if (!input.systemPrompt) throw new BarryError("invalid", "A session started over HTTP needs a systemPrompt");
        const boundNames = input.bounds?.filter((b): b is string => typeof b === "string");
        const modelProvider = input.modelVendor ?? input.modelProvider;
        const created = await translated(async () => client.sessions.create({
          systemPrompt: input.systemPrompt!,
          identityId: await identityId(client, identity),
          ...(input.prompt ? { prompt: input.prompt } : {}),
          ...(input.repoPath ? { repoPath: input.repoPath } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.bags ? { bags: [...input.bags] } : {}),
          ...(boundNames !== undefined ? { bounds: boundNames } : {}),
          ...(input.harness ? { provider: input.harness } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(modelProvider ? { modelProvider } : {}),
          ...(input.bound !== undefined ? { bound: plain(input.bound) } : {}),
          ...(input.useWorktree !== undefined ? { useWorktree: input.useWorktree } : {}),
        }));
        return created;
      },
      update: (_identity, id, changes) => {
        const boundNames = changes.bounds?.filter((b): b is string => typeof b === "string");
        const modelProvider = changes.modelVendor ?? changes.modelProvider;
        return translated(() => client.sessions.update(id, {
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.bags ? { bags: [...changes.bags] } : {}),
          ...(boundNames !== undefined ? { bounds: boundNames } : {}),
          ...(changes.pinned !== undefined ? { pinned: changes.pinned } : {}),
          ...(changes.bound !== undefined ? { bound: plain(changes.bound) } : {}),
          ...(changes.harness ? { provider: changes.harness } : {}),
          ...(changes.model ? { model: changes.model } : {}),
          ...(modelProvider ? { modelProvider } : {}),
        }));
      },
      messages: async (_identity, id, query, cursor) => {
        const newestFirst = query.before !== undefined || query.newestFirst === true;
        const bound = cursor === null ? (newestFirst ? query.before : query.after ?? -1) : Number(cursor);
        const page = await translated(() => client.sessions.messages(id, {
          ...(newestFirst ? { before: bound } : { after: bound }),
          limit: 500,
          ...(query.brief === true ? { summary: true } : {}),
        }));
        const items = newestFirst ? [...page.messages].reverse() : page.messages;
        return { items, next: page.hasMore && items.length > 0 ? String(items[items.length - 1].sequence) : null };
      },
      message: async (_identity, id, sequence) => {
        const page = await translated(() => client.sessions.messages(id, { after: sequence - 1, limit: 1 }));
        const found = page.messages[0];
        if (!found || found.sequence !== sequence) throw new BarryError("not_found", `Message ${sequence} of session ${id} not found`);
        return found;
      },
      listening: async (_identity, id) => {
        const listeners = (await translated(() => client.sessions.guarantees([id])))[id];
        return listeners !== undefined && (listeners.listeners.length > 0 || listeners.guarantee !== "none");
      },
      events: () => notYet("A session's live events"),
      send: async (_identity, id, text, options) => {
        const sent = await translated(() => client.sessions.send(id, text, options));
        return { state: sent.deliveryState, ...(sent.messageId ? { messageId: sent.messageId } : {}), clientMessageId: sent.clientMessageId ?? null };
      },
      end: (_identity, id) => translated(() => client.sessions.stop(id)),
      archive: (_identity, id) => translated(() => client.sessions.archive(id)),
      removeAll: () => notYet("Removing every session of an identity on its own (removing the identity removes them)"),
    },
    actions: {
      name: "actions",
      list: async () => (await translated(() => client.actions.catalog())).actions.map(action),
      forSession: async (_identity, id) => (await translated(() => client.actions.catalog({ sessionId: id }))).actions.map(action),
      run: async (actionName, inputs, options, caller) => {
        const result = await translated(() => client.actions.run(actionName, { inputs, ...options, ...(caller.kind === "session" ? { callerSessionId: caller.sessionId } : {}) }));
        const record = await translated(() => client.actions.getRun(result.runId));
        if (!record) throw new BarryError("not_found", `Action run ${result.runId} is gone`);
        return run(record);
      },
      runs: async (query) => (await translated(() => client.actions.listRuns({ action: query.action, scheduleId: query.schedule, limit: query.limit }))).map(run),
    },
    events: {
      name: "events",
      list: async (query, cursor) => {
        const page = await translated(() => client.events.list({
          ...(cursor ? { cursor } : {}), ...(query.session ? { sessionId: query.session } : {}), ...(query.type ? { type: query.type } : {}),
          ...(query.unread !== undefined ? { unread: query.unread } : {}), ...(query.since ? { since: query.since } : {}),
        }));
        return { items: page.events, next: page.nextCursor } satisfies Page<(typeof page.events)[number]>;
      },
      record: (input) => translated(() => client.events.create({
        type: input.type, title: input.title, ...(input.body ? { body: input.body } : {}), ...(input.severity ? { severity: input.severity } : {}),
        ...(input.session ? { sessionId: input.session } : {}), ...(input.data ? { data: input.data } : {}),
      })),
    },
    schedules: {
      name: "schedules",
      list: async () => (await translated(() => client.schedules.recurring())).schedules.map((s) => ({
        id: s.id, trigger: s.trigger, action: s.action, enabled: s.enabled, paused: s.paused,
        ...(s.job ? { job: s.job } : {}), ...(s.description ? { description: s.description } : {}),
        nextFireAt: s.next_fire_at, lastFiredAt: s.last_fired_at, lastStatus: s.last_status,
        lastSummary: s.last_summary, lastRunId: s.last_run_id, consecutiveFailures: s.consecutive_failures,
        skippedFires: s.skipped_fires, missedFires: s.missed_fires,
      })),
      scheduler: async () => {
        const page = await translated(() => client.schedules.recurring());
        return { status: page.scheduler.status, reason: page.scheduler.reason ?? null,
          heartbeatAt: page.scheduler.heartbeat_at, loadErrors: page.load_errors };
      },
      atSchedules: (query) => translated(() => client.schedules.list(query)),
      cancelAtSchedule: (id) => translated(async () => {
        await client.schedules.cancel(id);
        const after = await client.schedules.get(id);
        if (!after) throw new BarryError("not_found", `Schedule not found: ${id}`);
        return after;
      }),
      scheduleAt: (input) => translated(() => client.schedules.schedule(input.dueAt, {
        action: input.action, ...(input.inputs ? { inputs: input.inputs } : {}), ...(input.identity !== undefined ? { identity: String(input.identity) } : {}),
        ...(input.bags ? { bags: [...input.bags] } : {}),
        ...(input.bounds !== undefined ? { bounds: [...input.bounds] } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
      })),
    },
    bags: {
      name: "bags",
      list: () => translated(() => client.identities.bags()),
      tools: () => notYet("A bag's tools"),
      runJob: async (bag, job, inputs, options) => {
        if (options.identity !== undefined) notYet("Running a job as an identity");
        return (await translated(() => client.jobs.run(`${bag}:${job}`, inputs, {
          ...(options.key ? { key: options.key } : {}),
        }))).state;
      },
    },
    tracker: {
      name: "tracker",
      lastChanges: () => notYet("The last change to a file"),
      changes: async (_identity, id) => {
        const session = await translated(() => client.sessions.get(id));
        if (!session) throw new BarryError("not_found", `Session ${id} not found`);
        return (await translated(() => client.sessions.changes(id))).map(change => ({
          sessionId: change.sessionId,
          path: change.filePath,
          at: new Date(change.createdAt.replace(" ", "T") + (change.createdAt.endsWith("Z") ? "" : "Z")).toISOString(),
          tool: change.tool,
        }));
      },
    },
    services: {
      name: "services",
      list: () => translated(() => client.services.list()),
      get: async key => {
        const service = await translated(() => client.services.get(key));
        if (!service) throw new BarryError("not_found", `Service ${key} not found`);
        return service;
      },
      start: (key, caller) => serviceControl("start", key, caller),
      stop: (key, caller) => serviceControl("stop", key, caller),
      restart: (key, caller) => serviceControl("restart", key, caller),
    },
  };
  return subjects[name];
}
