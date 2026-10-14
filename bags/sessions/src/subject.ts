/**
 * The sessions subject: this bag's answer to `Barry.identity(ref).session(id)`
 * and `Barry.identity(ref).sessions()`. A session belongs to its identity, so
 * every call names both; asking for a session through another identity is
 * refused as not found. What a session is granted is composed by the
 * identities subject from what the session's row selected, so a session and a
 * launch can never disagree about it.
 *
 * Reads and settings are answered here, through this bag's store client.
 * Starting, messaging and ending a session need the runtime that runs its
 * agent, the sessions API, so those go to it over HTTP from every process, the
 * API's own included. The subject checks the caller itself first: the API is
 * asked with the instance's secret, which would allow anything.
 */
import { MODE_IDS, type ModeId } from "@barry-rocks/sdk/ids";
import type { z } from "zod";
import { Barry, BarryError, type BarryErrorReason, type Caller, type GrantSelection, type Grants, type IdentityReference, type Sessions } from "@barry-rocks/sdk";
import type { Bound } from "@barry-rocks/sdk/bounds";
import { hasScope } from "@barry-rocks/sdk/internal/auth";
import { BarryApiError, BarryClient } from "@barry-rocks/sdk/internal/client";
import { getServiceUrl, instanceEnvValue } from "@barry-rocks/sdk/services";

import { CreateSessionRequestSchema, SendMessageRequestSchema, UpdateSessionRequestSchema } from "@barry-rocks/sdk/internal/sessions";
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
export function selectionOf(row: SessionRecord): GrantSelection {
  if (row.bound_id != null) throw new BarryError("conflict", `Session ${row.id} still carries bound_id`, "barry doctor --fix");
  const metadata = row.metadata ?? {};
  const harness = harnessOf(metadata.provider);
  const namespaces = Array.isArray(metadata.selected_namespaces) ? metadata.selected_namespaces : [];
  const tools = Array.isArray(metadata.selected_tools) ? metadata.selected_tools : [];
  return {
    traits: row.traits,
    ...(harness ? { harness } : {}),
    ...(typeof metadata.mode === "string" && MODE_IDS.includes(metadata.mode as ModeId) ? { mode: metadata.mode as ModeId } : {}),
    bounds: row.bounds,
    inlineBound: row.bound,
    // A session started for an execution context is granted only what that context names.
    defaults: !metadata.execution_context,
    ...(namespaces.length > 0 ? { namespaces } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/**
 * What a session is granted, for a process that holds only its id (the MCP
 * server's `?sessionId=`, a harness hook), or its row when it already read
 * one. An unknown session is granted what a session that selected nothing is:
 * the defaults. Without a caller it asks as the process's ambient one.
 */
export async function sessionGrants(session: string | SessionRecord, caller?: Caller): Promise<Grants> {
  const row = typeof session === "string" ? await getSession(session) : session;
  const asked = caller ? Barry.as(caller) : Barry;
  if (!row) return asked.grants({});
  const selection = selectionOf(row);
  return row.identity_id === null ? asked.grants(selection) : asked.identity(row.identity_id).grants(selection);
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
function plain(bound: Bound | null): Record<string, unknown> | null {
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

export const sessions: Sessions = {
  name: "sessions",
  async list(identity, query, cursor, caller) {
    const owner = await Barry.as(caller).identity(identity).get();
    mayReadSessions(caller);
    const before = cursor === null ? undefined : decodeSessionCursor(cursor);
    if (before === null) throw new BarryError("invalid", "The session cursor is malformed");
    if (query.since !== undefined && Number.isNaN(Date.parse(query.since))) throw new BarryError("invalid", `since is not a date: ${query.since}`);
    const rows = await listSessions({
      // A device's own access rule: the identities it was granted, and no other user's sessions.
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
    // Status and pinned are matched after the page, so it can come back short.
    // Status is matched as the session reports it, which a closed row's column is not.
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
    const request = valid(CreateSessionRequestSchema, {
      systemPrompt: input.systemPrompt,
      identityId: owner.id,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.repoPath !== undefined ? { repoPath: input.repoPath } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.traits !== undefined ? { traits: [...input.traits] } : {}),
      ...(input.harness !== undefined ? { provider: input.harness } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.modelProvider !== undefined ? { modelProvider: input.modelProvider } : {}),
      ...(input.bounds !== undefined ? { bounds: [...input.bounds] } : {}),
      ...(input.inlineBound !== undefined ? { bound: plain(input.inlineBound) } : {}),
      ...(input.useWorktree !== undefined ? { useWorktree: input.useWorktree } : {}),
    });
    const created = await translated((runtime) => runtime.sessions.create(request));
    // Created but not running: the caller asked for an agent, and has none.
    if ("startError" in created) throw new BarryError("unavailable", `Session ${created.id} was created, but its agent did not start: ${created.startError}`);
    return sessionOf(await current(created.id), await getLiveProcess(created.id));
  },
  async update(identity, id, changes, caller) {
    mayControl(caller, "change sessions");
    const row = await owned(identity, id, caller);
    const request = valid(UpdateSessionRequestSchema, {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.traits !== undefined ? { traits: [...changes.traits] } : {}),
      ...(changes.pinned !== undefined ? { pinned: changes.pinned } : {}),
      ...(changes.bounds !== undefined ? { bounds: [...changes.bounds] } : {}),
      ...(changes.inlineBound !== undefined ? { bound: plain(changes.inlineBound) } : {}),
      ...(changes.harness !== undefined ? { provider: changes.harness } : {}),
      ...(changes.model !== undefined ? { model: changes.model } : {}),
      ...(changes.modelProvider !== undefined ? { modelProvider: changes.modelProvider } : {}),
    });
    if (request.bounds !== undefined) await Barry.as(caller).identity(identity).grants({ ...selectionOf(row), bounds: request.bounds });
    const metadata = {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
      ...(request.provider !== undefined ? { provider: request.provider } : {}),
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.modelProvider !== undefined ? { model_provider: request.modelProvider } : {}),
    };
    if (Object.keys(metadata).length > 0) await updateSessionMetadataNormalized(id, metadata);
    const columns = {
      ...(request.traits !== undefined ? { traits: request.traits } : {}),
      ...(request.bound !== undefined ? { bound: request.bound } : {}),
      ...(request.bounds !== undefined ? { bounds: request.bounds } : {}),
    };
    if (Object.keys(columns).length > 0) await updateSession(id, columns);
    return sessionOf(await current(id), await getLiveProcess(id));
  },
  async grants(identity, id, caller) {
    const row = await owned(identity, id, caller);
    const selection = selectionOf(row);
    return Barry.as(caller).identity(row.identity_id ?? identity).grants(selection);
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
    // The delivery route serves the installation alone, so over HTTP a device is refused; in-process it is too.
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
