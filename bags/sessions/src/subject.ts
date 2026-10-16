/**
 * The sessions subject: this bag's answer to `Barry.identity(ref).session(id)`
 * and `Barry.identity(ref).sessions()`. A session belongs to its identity, so
 * every call names both; asking for a session through another identity is
 * refused as not found.
 *
 * Reads and settings are answered here, through this bag's store client.
 * Starting, messaging and ending a session need the runtime that runs its
 * agent, the sessions API, so those go to it over HTTP from every process, the
 * API's own included. The subject checks the caller itself first: the API is
 * asked with the instance's secret, which would allow anything.
 */
import type { z } from "zod";
import {
  Barry,
  BarryError,
  isBarryError,
  type Bag,
  type BagToolInput,
  type BarryErrorReason,
  type Caller,
  type IdentityReference,
  type Sessions,
  type Tool,
} from "@barry-rocks/sdk";
import { filterToolObjects, mergeBounds, type Bound } from "@barry-rocks/sdk/bounds";
import { hasScope } from "@barry-rocks/sdk/internal/auth";
import { BarryApiError, BarryClient } from "@barry-rocks/sdk/internal/client";
import { getServiceUrl, instanceEnvValue } from "@barry-rocks/sdk/services";
import {
  CreateSessionRequestSchema,
  SendMessageRequestSchema,
  UpdateSessionRequestSchema,
} from "@barry-rocks/sdk/internal/sessions";
import {
  archiveSession,
  deleteSessionsByIdentity,
  getLiveProcess,
  getLiveProcessesBySessions,
  getSession,
  getSessionMessages,
  getListeners,
  listSessions,
  updateSession,
  updateSessionMetadataNormalized,
  type SessionRecord,
} from "./client/index.js";
import { MODE_IDS, type ModeId } from "@barry-rocks/sdk/ids";
import { decodeSessionCursor, encodeSessionCursor, harnessOf, messageOf, sessionOf } from "./domain.js";

const SESSION_PAGE = 50;
const MESSAGE_PAGE = 500;
/**
 * Starting a session waits for its agent, which can outlast the client's
 * default ten seconds; a create that timed out after it succeeded would be
 * reported as failed.
 */
const RUNTIME_TIMEOUT_MS = 60_000;

/** What a session's row selected on top of its identity. */
export function selectionOf(row: SessionRecord) {
  const metadata = row.metadata ?? {};
  const harness = harnessOf(metadata.provider);
  const namespaces = Array.isArray(metadata.selected_namespaces) ? metadata.selected_namespaces : [];
  const tools = Array.isArray(metadata.selected_tools) ? metadata.selected_tools : [];
  return {
    bags: row.bags,
    ...(harness ? { harness } : {}),
    ...(typeof metadata.mode === "string" && MODE_IDS.includes(metadata.mode as ModeId) ? { mode: metadata.mode as ModeId } : {}),
    bounds: row.bounds,
    bound: row.bound,
    defaults: !metadata.execution_context,
    ...(namespaces.length > 0 ? { namespaces } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function askedBarry(caller?: Caller) {
  return caller ? Barry.as(caller) : Barry;
}

/**
 * Resolve the active bag names for a session row.
 *
 * When a session explicitly selects `bags` (or runs under an explicit execution
 * context / `explicit_bags`), those bags are used directly; otherwise it
 * inherits its identity's configured bags.
 */
export async function resolveSessionBags(
  row: SessionRecord,
  caller?: Caller,
): Promise<string[]> {
  const metadata = row.metadata ?? {};
  if (row.bags.length > 0 || metadata.execution_context || metadata.explicit_bags) {
    return [...row.bags];
  }
  if (row.identity_id !== null) {
    try {
      const identity = await askedBarry(caller).identity(row.identity_id).get();
      return [...identity.bags];
    } catch (error) {
      if (isBarryError(error) && (error.reason === "not_found" || error.reason === "forbidden")) {
        return [];
      }
      throw error;
    }
  }
  return [];
}

/**
 * Resolve the effective `Bound` for a session.
 *
 * Returns `row.bound` when pinned on the session row ([DESIGN.md §7.1.4]) so
 * live `identity.yaml` or `bag.yaml` edits never alter a running session's
 * bound. Falls back to resolving `Barry.bound(identity, row.bounds)` when the
 * row has no pinned `bound`.
 */
export async function sessionBound(
  session: string | SessionRecord | null | undefined,
  caller?: Caller,
): Promise<Bound | null> {
  const row = typeof session === "string" ? await getSession(session) : session;
  const asked = askedBarry(caller);
  if (!row) {
    return asked.bound(null, []);
  }
  if (row.bound !== null && row.bound !== undefined) {
    return row.bound as Bound;
  }
  return asked.bound(row.identity_id ?? null, row.bounds ?? []);
}

/**
 * Resolve the tools available to a session given its active bags and pinned bound.
 */
export async function resolveSessionTools(
  session: string | SessionRecord | null | undefined,
  caller?: Caller,
  servedTools?: readonly BagToolInput[],
): Promise<Tool[]> {
  const row = typeof session === "string" ? await getSession(session) : session;
  const asked = askedBarry(caller);
  const pinnedBound = await sessionBound(row, caller);
  const activeBags = row ? await resolveSessionBags(row, caller) : undefined;
  const isExplicit = Boolean(row?.metadata?.execution_context || row?.metadata?.explicit_bags);
  let tools = await asked.tools(
    isExplicit ? null : (row?.identity_id ?? null),
    activeBags,
    pinnedBound ?? undefined,
  );
  if (servedTools?.length) {
    const activeSet = activeBags ? new Set(activeBags) : null;
    const existingNames = new Set(tools.map((t) => `${t.namespace}:${t.name}`));
    const extraCandidates: { namespace: string; toolName: string; access: "read" | "write" }[] = [];
    for (const meta of servedTools) {
      const namespace = meta.namespace ?? meta.bag ?? "";
      const toolName = meta.toolName ?? meta.name ?? "";
      if (!namespace || !toolName) continue;
      const qualified = `${namespace}:${toolName}`;
      if (existingNames.has(qualified)) continue;
      if (activeSet && !activeSet.has(namespace) && namespace !== "barry") continue;
      extraCandidates.push({ namespace, toolName, access: meta.access === "read" ? "read" : "write" });
    }
    if (extraCandidates.length > 0) {
      const allowedExtras = filterToolObjects(extraCandidates, pinnedBound);
      tools = [
        ...tools,
        ...allowedExtras.map((meta) => ({
          name: meta.toolName ?? "",
          namespace: meta.namespace,
          bag: meta.namespace,
          access: (meta.access === "read" ? "read" : "write") as Tool["access"],
        })),
      ];
    }
  }
  const metadata = row?.metadata ?? {};
  const selectedNamespaces = Array.isArray(metadata.selected_namespaces)
    ? metadata.selected_namespaces
    : [];
  const selectedTools = Array.isArray(metadata.selected_tools)
    ? metadata.selected_tools
    : [];
  if (selectedNamespaces.length > 0 || selectedTools.length > 0) {
    const nsSet = new Set(selectedNamespaces);
    const toolSet = new Set(selectedTools);
    tools = tools.filter(
      (tool) =>
        tool.namespace === "barry" ||
        nsSet.has(tool.namespace) ||
        toolSet.has(tool.name) ||
        toolSet.has(`${tool.namespace}:${tool.name}`),
    );
  }
  return tools;
}

function mayReadSessions(caller: Caller): void {
  if (caller.kind === "device" && !hasScope(caller.principal, "sessions:read")) {
    throw new BarryError("forbidden", "This device may not read sessions");
  }
}

/** A device may read sessions but not control them: running one needs tool, credential and bound enforcement it does not have yet. */
function mayControl(caller: Caller, what: string): void {
  if (caller.kind === "device") throw new BarryError("forbidden", `A device may not ${what}`);
}

/** The session, when it belongs to the identity named and the caller may read it. */
async function owned(identity: IdentityReference, id: string, caller: Caller): Promise<SessionRecord> {
  const row = await getSession(id);
  const missing = new BarryError("not_found", `Session ${id} not found`);
  if (!row || row.identity_id === null) throw missing;
  const owner = await Barry.as(caller).identity(row.identity_id).get();
  if (identity !== owner.name && identity !== owner.id && identity !== row.identity_id) {
    const asked = await Barry.as(caller).identity(identity).get();
    if (asked.id !== owner.id) throw missing;
  }
  if (caller.kind === "session" && caller.sessionId !== id && caller.identity !== owner.name && caller.identity !== owner.id) throw missing;
  if (caller.kind === "device") {
    mayReadSessions(caller);
    // Another user's session is not this device's, whichever identity it ran as.
    if (row.user_id !== null && row.user_id !== caller.principal.actorId) throw missing;
  }
  return row;
}

/** A request body the sessions API would accept, checked by the same schema its route checks with. */
function valid<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new BarryError("invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "));
}

/** A bound as a request body carries it: a plain JSON object. */
function plain(bound: Bound | null | undefined): Record<string, unknown> | null {
  return bound ? Object.fromEntries(Object.entries(bound)) : null;
}

function reasonOf(status: number | null): BarryErrorReason {
  return status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 409 ? "conflict"
    : status === 400 || status === 422 ? "invalid" : "unavailable";
}

/** Where the sessions API listens and the secret it takes, looked up per call so a moved service is found. */
function runtimeAddress(): { baseUrl: string; secret: string } {
  const secret = instanceEnvValue("BARRY_SECRET");
  if (!secret) throw new BarryError("unavailable", "This instance has no BARRY_SECRET, so its sessions API cannot be reached", "Run barry setup");
  try {
    return { baseUrl: getServiceUrl("api"), secret };
  } catch (error) {
    throw new BarryError("unavailable", `The sessions API is not registered: ${error instanceof Error ? error.message : String(error)}`, "Start it with barry service start sessions.api");
  }
}

/** A refusal from the sessions API, as the same error an in-process refusal throws. */
async function translated<T>(call: (runtime: BarryClient) => Promise<T>): Promise<T> {
  const runtime = BarryClient.connect({ ...runtimeAddress(), timeoutMs: RUNTIME_TIMEOUT_MS });
  try {
    return await call(runtime);
  } catch (error) {
    if (!(error instanceof BarryApiError)) throw error;
    throw new BarryError(reasonOf(error.status), error.message);
  }
}

/** The row as it is now, after a change this process made or asked for. */
async function current(id: string): Promise<SessionRecord> {
  const row = await getSession(id);
  if (!row) throw new BarryError("not_found", `Session ${id} not found`);
  return row;
}

function splitBoundsInput(
  bounds: readonly (Bound | string)[] | undefined,
): { names: string[]; bound: Bound | null; combined: (Bound | string)[] } {
  const names: string[] = [];
  const objects: Bound[] = [];
  for (const entry of bounds ?? []) {
    if (typeof entry === "string") {
      names.push(entry);
    } else if (entry && typeof entry === "object") {
      objects.push(entry);
    }
  }
  return {
    names,
    bound: objects.length > 0 ? mergeBounds(...objects) : null,
    combined: [...names, ...objects],
  };
}

export const sessions: Sessions = {
  name: "sessions",
  async list(identity, query, cursor, caller) {
    const owner = await Barry.as(caller).identity(identity).get();
    mayReadSessions(caller);
    const before = cursor === null ? undefined : decodeSessionCursor(cursor);
    if (before === null) throw new BarryError("invalid", "The session cursor is malformed");
    if (query.since !== undefined && Number.isNaN(Date.parse(query.since))) throw new BarryError("invalid", `since is not a date: ${query.since}`);
    const rows = await listSessions({
      ...(caller.kind === "device" ? { access: { actorId: caller.principal.actorId, identityIds: [owner.id] } } : {}),
      identityId: owner.id,
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.order === "activity" ? { orderBy: "activity" as const } : {}),
      limit: SESSION_PAGE + 1,
      ...(before ? { before } : {}),
      ...(query.search ? { query: query.search } : {}),
      ...(query.since ? { createdAfter: query.since } : {}),
    });
    const page = rows.slice(0, SESSION_PAGE);
    const live = await getLiveProcessesBySessions(page.map((row) => row.id));
    const statuses = typeof query.status === "string" ? [query.status] : query.status;
    const items = page
      .map((row) => sessionOf(row, live.get(row.id) ?? null))
      .filter((session) => (statuses === undefined || statuses.includes(session.status)) && (query.pinned === undefined || session.pinned === query.pinned));
    return { items, next: rows.length > SESSION_PAGE ? encodeSessionCursor(page[page.length - 1]) : null };
  },
  async get(identity, id, caller) {
    return sessionOf(await owned(identity, id, caller), await getLiveProcess(id));
  },
  async start(identity, input, caller) {
    mayControl(caller, "start sessions");
    const owner = await Barry.as(caller).identity(identity).get();
    if (!input.systemPrompt) throw new BarryError("invalid", "Starting a session needs a systemPrompt");
    const bags = input.bags;
    const hasBounds = input.bounds !== undefined;
    const split = splitBoundsInput(input.bounds);
    if (hasBounds) {
      await Barry.as(caller).bound(identity, split.combined);
    }
    const request = valid(CreateSessionRequestSchema, {
      systemPrompt: input.systemPrompt,
      identityId: owner.id,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.repoPath !== undefined ? { repoPath: input.repoPath } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(bags !== undefined ? { bags: [...bags] } : {}),
      ...(input.harness !== undefined ? { provider: input.harness } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.modelProvider !== undefined ? { modelProvider: input.modelProvider } : {}),
      ...(input.bounds !== undefined ? { bounds: split.names } : {}),
      ...(split.bound ? { bound: plain(split.bound) } : {}),
      ...(input.useWorktree !== undefined ? { useWorktree: input.useWorktree } : {}),
    });
    const created = await translated((runtime) => runtime.sessions.create(request));
    if ("startError" in created) throw new BarryError("unavailable", `Session ${created.id} was created, but its agent did not start: ${created.startError}`);
    return sessionOf(await current(created.id), await getLiveProcess(created.id));
  },
  async update(identity, id, changes, caller) {
    mayControl(caller, "change sessions");
    const row = await owned(identity, id, caller);
    const bags = changes.bags;
    const hasBoundsChange = changes.bounds !== undefined;
    const split = splitBoundsInput(
      changes.bounds !== undefined ? changes.bounds : row.bounds,
    );
    const request = valid(UpdateSessionRequestSchema, {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(bags !== undefined ? { bags: [...bags] } : {}),
      ...(changes.pinned !== undefined ? { pinned: changes.pinned } : {}),
      ...(changes.bounds !== undefined ? { bounds: split.names } : {}),
      ...(split.bound !== null ? { bound: plain(split.bound) } : {}),
      ...(changes.harness !== undefined ? { provider: changes.harness } : {}),
      ...(changes.model !== undefined ? { model: changes.model } : {}),
      ...(changes.modelProvider !== undefined ? { modelProvider: changes.modelProvider } : {}),
    });
    let pinnedBound: Bound | null | undefined;
    if (hasBoundsChange) {
      pinnedBound = await Barry.as(caller).bound(identity, split.combined);
    }
    const metadata = {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
      ...(request.provider !== undefined ? { provider: request.provider } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.modelProvider !== undefined ? { model_provider: request.modelProvider } : {}),
    };
    if (Object.keys(metadata).length > 0) await updateSessionMetadataNormalized(id, metadata);
    const columns = {
      ...(request.bags !== undefined ? { bags: request.bags } : {}),
      ...(changes.bounds !== undefined ? { bounds: split.names } : {}),
      ...(hasBoundsChange ? { bound: plain(pinnedBound) } : {}),
    };
    if (Object.keys(columns).length > 0) await updateSession(id, columns);
    return sessionOf(await current(id), await getLiveProcess(id));
  },
  async bags(identity, id, caller) {
    const row = await owned(identity, id, caller);
    const bagNames = await resolveSessionBags(row, caller);
    let installed: Bag[] = [];
    try {
      installed = await Barry.as(caller).bags();
    } catch {
      installed = [];
    }
    const byName = new Map(installed.map((bag) => [bag.name, bag]));
    return bagNames.map(
      (name) =>
        byName.get(name) ?? {
          name,
          type: "local" as const,
          description: null,
        },
    );
  },
  async bounds(identity, id, caller) {
    const row = await owned(identity, id, caller);
    return [...row.bounds];
  },
  async bound(identity, id, caller) {
    const row = await owned(identity, id, caller);
    return sessionBound(row, caller);
  },
  async tools(identity, id, caller) {
    const row = await owned(identity, id, caller);
    return resolveSessionTools(row, caller);
  },
  async skills(identity, id, caller) {
    const row = await owned(identity, id, caller);
    const activeBags = await resolveSessionBags(row, caller);
    return Barry.as(caller).skills(row.identity_id ?? identity, activeBags);
  },
  async instructions(identity, id, caller) {
    const row = await owned(identity, id, caller);
    const activeBags = await resolveSessionBags(row, caller);
    return Barry.as(caller).instructions(row.identity_id ?? identity, activeBags);
  },
  async actions(identity, id, caller) {
    const row = await owned(identity, id, caller);
    const activeBags = await resolveSessionBags(row, caller);
    return Barry.as(caller).actions(row.identity_id ?? identity, activeBags);
  },
  async messages(identity, id, query, cursor, caller) {
    await owned(identity, id, caller);
    if (cursor !== null && !/^\d+$/.test(cursor)) throw new BarryError("invalid", "The message cursor is malformed");
    const newestFirst = query.before !== undefined || query.newestFirst === true;
    const bound = cursor === null ? (newestFirst ? query.before : query.after ?? -1) : Number(cursor);
    const { messages, hasMore } = await getSessionMessages(id, {
      ...(newestFirst ? { beforeSequence: bound } : { afterSequence: bound }),
      summary: query.brief === true,
      limit: MESSAGE_PAGE,
    });
    const items = messages.map(messageOf);
    if (newestFirst) items.reverse();
    return { items, next: hasMore && items.length > 0 ? String(items[items.length - 1].sequence) : null };
  },
  async message(identity, id, sequence, caller) {
    await owned(identity, id, caller);
    const { messages } = await getSessionMessages(id, { afterSequence: sequence - 1, limit: 1 });
    const found = messages[0];
    if (!found || found.sequence !== sequence) throw new BarryError("not_found", `Message ${sequence} of session ${id} not found`);
    return messageOf(found);
  },
  async listening(identity, id, caller) {
    if (caller.kind === "device") throw new BarryError("forbidden", "A device may not read whether a session is listened to");
    await owned(identity, id, caller);
    const listeners = (await getListeners([id]))[id];
    return listeners !== undefined && (listeners.listeners.length > 0 || listeners.guarantee !== "none");
  },
  events() {
    throw new BarryError(
      "unavailable",
      "A session's live events have no stream yet",
      "Read messages with session.messages(), recorded events with Barry.events({ session: id }); a turn an app runs streams over AG-UI (AgUiConnection.subscribe from @barry-rocks/sdk/apps)",
    );
  },
  async send(identity, id, text, options, caller) {
    mayControl(caller, "message sessions");
    await owned(identity, id, caller);
    valid(SendMessageRequestSchema, { content: text, ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}) });
    const sent = await translated((runtime) => runtime.sessions.send(id, text, options));
    return { state: sent.deliveryState, ...(sent.messageId ? { messageId: sent.messageId } : {}), clientMessageId: sent.clientMessageId ?? null };
  },
  async end(identity, id, caller) {
    mayControl(caller, "end sessions");
    await owned(identity, id, caller);
    await translated((runtime) => runtime.sessions.stop(id));
  },
  async archive(identity, id, caller) {
    mayControl(caller, "archive sessions");
    await owned(identity, id, caller);
    await archiveSession(id);
  },
  async removeAll(identity, caller) {
    if (caller.kind !== "owner") throw new BarryError("forbidden", "Only the installation's owner may remove an identity's sessions");
    const owner = await Barry.as(caller).identity(identity).get();
    return deleteSessionsByIdentity(owner.id);
  },
};
