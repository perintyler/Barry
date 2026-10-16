import { residentSession } from "../turn-execution.js";
import { Events } from "@barry-rocks/events-bag";
import { revalidateRequestAuthorization } from "@barry-rocks/sdk/internal/auth";
import { createLogger } from "@barry-rocks/sdk/logging";
import { sessionsRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
import {
	Processes,
	Sessions,
	archiveSession,
	getLatestActivityBySessions,
	getSession,
	listSessions,
	getFirstUserMessages as seamGetFirstUserMessages,
	searchMessages,
} from "@barry-rocks/sessions-bag/client";
import { authorizeSessionExecution, SessionExecutionResourceUnavailable } from "@barry-rocks/sessions-bag/execution-authorization";
import { endSession, startSession, type StartSessionInput } from "@barry-rocks/sessions-bag/lifecycle";
import { getDistinctFilesForSessions } from "@barry-rocks/tracker-bag";
import { Router } from "express";
import { basename } from "path";
import { isStartValidationError } from "./start-session-errors.js";
import { listSessionRecords } from "../db.js";
import { sendProblem } from "../http.js";
import { expandUserPath } from "../repo-paths.js";
import { sessionRuntime } from "../session-runtime.js";
import { decodeSessionCursor, encodeSessionCursor, serializeSession as serializeSessionRecord } from "../session-serialize.js";
const serializeSession=(...args:Parameters<typeof serializeSessionRecord>)=>({...serializeSessionRecord(...args),lastEventAt:sessionRuntime.getActiveSession?.(args[0].id)?.lastEventAt??null});

import { groupFilesByRepo, repoDisplayName } from "./session-view.js";

export const sessionsRouter = Router();
const routes = serve(sessionsRouter, "/sessions", { casing: "camel" });
const log = createLogger("barry-server");

/** Project latest activity onto the wire; count is message presence, avoiding an unbounded history scan. */
async function getMessageStats(ids: string[], access?: Parameters<typeof getLatestActivityBySessions>[1]): Promise<Map<string, { count: number; lastMessageAt: string | null }>> {
  const activity = await getLatestActivityBySessions(ids, access);
  const stats = new Map<string, { count: number; lastMessageAt: string | null }>();
  for (const [sessionId, a] of activity) {
    stats.set(sessionId, { count: a.hasMessages ? 1 : 0, lastMessageAt: a.lastMessageAt });
  }
  return stats;
}

// List sessions with an opaque cursor so concurrent inserts cannot shift pages.
routes.route(sessionsRoutes.listSessions, async (req, res) => {
  const identityId = req.query.identityId === undefined ? undefined : Number(req.query.identityId);
  if (identityId !== undefined && (!Number.isSafeInteger(identityId) || identityId <= 0 || typeof req.query.identityId !== "string")) {
    return res.status(400).type("application/problem+json").json({
      type: "about:blank", title: "Invalid identityId", status: 400,
      detail: "identityId must be a positive integer", instance: req.originalUrl,
    });
  }
  const active = req.query.active === "true";
  const includeArchived = req.query.includeArchived === "true";
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 100);
  const cursor = req.query.cursor === undefined ? undefined : decodeSessionCursor(req.query.cursor);

  if (req.query.cursor !== undefined && !cursor) {
    return res.status(400).type("application/problem+json").json({
      type: "about:blank",
      title: "Invalid cursor",
      status: 400,
      detail: "The session cursor is malformed",
      instance: req.originalUrl,
    });
  }

  // ID-only requests bypass full enrichment for liveness probes; see docs/decisions/0020-session-route-and-cache-invariants.md.
  const idsOnly = req.query.fields === "id";

  // Opt-in so every existing caller keeps its current paging. "activity" is
  // what a "most recent sessions" list means — see migration 032.
  const orderBy = req.query.order === "activity" ? "activity" as const : "created_at" as const;

  try {
    const access = req.authPrincipal?.kind === "device" ? { actorId: req.authPrincipal.actorId, identityIds: req.authPrincipal.identityIds } : undefined;
    const rows = await listSessions({
      access,
      identityId,
      limit: limit + 1,
      active: active ? true : undefined,
      includeArchived,
      before: cursor ?? undefined,
      orderBy,
      query: typeof req.query.query === "string" ? req.query.query : undefined,
      // Opt-in, so every existing caller keeps its current results. Clients
      // that hide message-less sessions ask for it and get a full page of rows
      // they can actually render, instead of paging past invisible ones.
      hasMessages: req.query.hasMessages === "true" ? true : undefined,
    });
    const hasMore = rows.length > limit;
    const sessions = rows.slice(0, limit);
    const nextCursor = hasMore && sessions.length > 0 ? encodeSessionCursor(sessions[sessions.length - 1]) : null;

    if (idsOnly) {
      res.json({ sessions: sessions.map((s) => ({ id: s.id })), nextCursor });
      return;
    }

    // Enrich with message counts/timestamps and normalize to camelCase
    const sessionIds = sessions.map((s) => s.id);
    const [statsMap, progressMap, liveProcesses] = await Promise.all([
      getMessageStats(sessionIds, access),
      access ? Promise.resolve(new Map()) : Events.getLatestBySessions(sessionIds, "progress"),
      Processes.getLiveBySessions(sessionIds),
    ]);
    const liveIds = new Set(sessionRuntime.getActiveSessionIds());
    const enriched = sessions.map((session) => {
      const stats = statsMap.get(session.id);
      return serializeSession(
        session,
        liveProcesses.get(session.id) ?? null,
        {
          messageCount: stats?.count ?? 0,
          // Prefer the stored column — it is the key the list SORTS by, and it
          // is the max message time, whereas getMessageStats reports the
          // highest-SEQUENCE row. Those disagree on 23 of this database's 717
          // sessions (worst case 83 hours apart) because messages can persist
          // out of order, and serving one while sorting by the other shows a
          // row sitting above a newer-looking timestamp.
          lastMessageAt: session.last_message_at ?? stats?.lastMessageAt ?? session.created_at,
        },
        progressMap.get(session.id),
        liveIds.has(session.id),
      );
    });

    res.json({ sessions: enriched, nextCursor });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).type("application/problem+json").json({ type: "about:blank", title: "Session query failed", status: 500, detail: message, instance: req.originalUrl });
  }
});

// --- Sessions picker (BDiff session view) -----------------------------------
// Lightweight list for the picker popover: running sessions first, then
// recently ended, each with the repos it touched. Registered before /:id.

const ENDED_STATUS_LIST = ["completed", "failed", "cancelled"] as const;
const ENDED_STATUSES = new Set<string>(ENDED_STATUS_LIST);
const PICKER_CACHE_TTL_MS = 15_000;
let pickerCache: { data: unknown; timestamp: number } | null = null;
// Coalesce concurrent picker rebuilds; see docs/decisions/0020-session-route-and-cache-invariants.md.
let pickerInflight: Promise<unknown> | null = null;

/**
 * First user message per session — the best display-name source when sessions
 * are unnamed.
 *
 * Goes through the seam. A raw query here would be invisible to the seam
 * guard, which checks IMPORTED surface names rather than direct `db` handle
 * use.
 */
async function getFirstUserMessages(ids: string[]): Promise<Map<string, string>> {
  return seamGetFirstUserMessages(ids);
}

/** Compact one-line display name from free text. */
function toDisplayName(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/**
 * A session only needs its first user message fetched when nothing higher in
 * the name-priority chain (explicit name, then summary) is already set — the
 * DISTINCT ON query returns full message text, so running it for a session
 * whose name the code was about to discard was pure waste.
 */
export function needsFirstMessageLookup(session: {
  metadata?: { name?: unknown } | null;
  summary?: string | null;
}): boolean {
  const md = session.metadata ?? {};
  const hasName = typeof md.name === "string" && md.name.trim().length > 0;
  const hasSummary = typeof session.summary === "string" && session.summary.trim().length > 0;
  return !hasName && !hasSummary;
}

interface PickerSession {
  id: string;
  name: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  repos: string[];
  hasChanges: boolean;
}

sessionsRouter.get("/picker", async (req, res) => {
  try {
    if (pickerCache && Date.now() - pickerCache.timestamp < PICKER_CACHE_TTL_MS) {
      res.set("X-Cache", "HIT");
      return res.json(pickerCache.data);
    }

    if (pickerInflight) {
      res.set("X-Cache", "JOIN");
      return res.json(await pickerInflight);
    }
    pickerInflight = buildPickerData().finally(() => {
      pickerInflight = null;
    });
    res.set("X-Cache", "MISS");
    return res.json(await pickerInflight);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).type("application/problem+json").json({ type: "about:blank", title: "Session picker failed", status: 500, detail: message, instance: req.originalUrl });
  }
});

async function buildPickerData(): Promise<unknown> {
    const [running, recent, recentlyEnded] = await Promise.all([
      listSessionRecords({ status: "running", limit: 50 }).catch(() => []),
      listSessionRecords({ limit: 100 }).catch(() => []),
      listSessionRecords({ statusIn: [...ENDED_STATUS_LIST], orderBy: "ended_at", limit: 50 }).catch(() => []),
    ]);

    // Sessions rest as "pending" in the DB between turns — SDK-manager
    // activity is the real liveness signal. Treat active sessions as running.
    const activeIds = new Set(sessionRuntime.getActiveSessionIds());
    const runningIds = new Set(running.map((s) => s.id));
    const activeExtra = recent.filter((s) => activeIds.has(s.id) && !runningIds.has(s.id));
    for (const s of activeExtra) runningIds.add(s.id);
    const live = [...running, ...activeExtra];

    // Merge ended sessions from both queries so sessions created long ago
    // but ended recently still appear (created_at-ordered `recent` can miss them).
    const endedById = new Map<string, typeof recent[number]>();
    for (const s of [...recent, ...recentlyEnded]) {
      if (!runningIds.has(s.id) && ENDED_STATUSES.has(s.status ?? "") && s.metadata?.working_directory) {
        endedById.set(s.id, s);
      }
    }
    const ended = [...endedById.values()]
      .sort((a, b) => (b.ended_at ?? b.created_at ?? "").localeCompare(a.ended_at ?? a.created_at ?? ""))
      .slice(0, 30);

    const all = [...live, ...ended];
    const filesBySession = getDistinctFilesForSessions(all.map((s) => s.id));

    // The first-message fallback only matters for sessions with neither an
    // explicit name nor a summary — fetching it for every session pulled full
    // message text that the name priority below immediately discarded.
    const unnamedIds = all.filter(needsFirstMessageLookup).map((s) => s.id);
    const firstMessages = await getFirstUserMessages(unnamedIds).catch(() => new Map<string, string>());

    const sessions: PickerSession[] = [];
    for (const session of all) {
      const metadata = session.metadata ?? {};
      let repos: string[] = [];

      if (metadata.use_worktree === true && typeof metadata.base_repo_path === "string") {
        repos = [basename(expandUserPath(metadata.base_repo_path))];
      } else {
        // Resolve tracked files to repo names; a handful of paths is enough.
        const tracked = (filesBySession.get(session.id) ?? []).slice(0, 20);
        if (tracked.length > 0) {
          const workingDirectory = typeof metadata.working_directory === "string"
            ? metadata.working_directory
            : undefined;
          const groups = await groupFilesByRepo(tracked, workingDirectory);
          repos = await Promise.all([...groups.keys()].sort().map((root) => repoDisplayName(root)));
        }
        if (repos.length === 0 && typeof metadata.working_directory === "string") {
          repos = [basename(expandUserPath(metadata.working_directory))];
        }
      }

      // Name priority: explicit name > summary > first user message > getName fallbacks
      const explicitName = typeof metadata.name === "string" && metadata.name.trim() ? metadata.name : null;
      const summary = typeof session.summary === "string" && session.summary.trim() ? session.summary : null;
      const firstMessage = firstMessages.get(session.id);
      const name = explicitName
        ?? (summary ? toDisplayName(summary) : null)
        ?? (firstMessage ? toDisplayName(firstMessage) : null)
        ?? Sessions.getName(session);

      const trackedFiles = filesBySession.get(session.id) ?? [];
      sessions.push({
        id: session.id,
        name,
        status: activeIds.has(session.id) ? "running" : (session.status ?? "pending"),
        startedAt: session.started_at,
        endedAt: session.ended_at,
        repos: [...new Set(repos)],
        hasChanges: trackedFiles.length > 0 || activeIds.has(session.id),
      });
    }

    const data = { sessions };
    pickerCache = { data, timestamp: Date.now() };
    return data;
}

const GUARANTEE_FIELD_TYPES = {
  capture: "string",
  delivery: "string",
  steer: "boolean",
  interrupt: "boolean",
  gating: "string",
  keepsVendorUi: "boolean",
  identity: "string",
} as const;

/** The guarantee fields a body carries, ignoring anything else in it. */
function guaranteesOf(value: unknown): StartSessionInput["guarantees"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const given = value as Record<string, unknown>;
  const fields = Object.entries(GUARANTEE_FIELD_TYPES).filter(([name, type]) => typeof given[name] === type);
  if (fields.length === 0) return undefined;
  return Object.fromEntries(fields.map(([name]) => [name, given[name]]));
}

// Start a session (called by SessionStart hook and CLI pre-spawn)
routes.route(sessionsRoutes.startNativeSession, async (req, res) => {
  try {
    const session_id = req.body.session_id ?? req.body.sessionId;
    const provider_session_id = req.body.provider_session_id ?? req.body.harness_session_id ?? req.body.harnessSessionId ?? req.body["provider" + "SessionId"];
    const provider = req.body.provider;
    const model = req.body.model;
    const model_provider = req.body.model_provider ?? req.body.modelProvider;
    // How Barry was attached: hosted | guest-plus | guest. One word, so the
    // camelCase contract and the snake_case alias layer spell it the same.
    const mode = req.body.mode;
    const guarantees = req.body.guarantees;
    const cwd = req.body.cwd;
    const directive = req.body.directive;
    const transcript_path = req.body.transcript_path ?? req.body.transcriptPath;
    const permission_mode = req.body.permission_mode ?? req.body.permissionMode;
    const source = req.body.source;
    const identity_id = req.body.identity_id ?? req.body.identityId;
    const name = req.body.name;
    // The v1 contract is camelCase; the internal alias layer also exposes
    // snake_case, so accept either rather than silently ignoring one.
    const bounds = req.body.bounds;
    const bags = req.body.bags;
    const status = req.body.status;
    if (status !== undefined && status !== "pending" && status !== "running") return res.status(400).json({ ok: false, error: "invalid session status" });
    if (bags !== undefined && (!Array.isArray(bags) || bags.some(name => typeof name !== "string" || !name.trim()))) return res.status(400).json({ ok: false, error: "bags must be an array of non-empty names" });

    if (Object.hasOwn(req.body, "boundId") || Object.hasOwn(req.body, "bound_id")) return res.status(400).json({ ok: false, error: "bounds are selected by name: send bounds" });
    if (bounds !== undefined && (!Array.isArray(bounds) || bounds.some(item => (typeof item === "string" ? !item.length : typeof item !== "object" || item === null)))) return res.status(400).json({ ok: false, error: "bounds must be an array of non-empty names or bound objects" });
    if (!session_id) {
      return res.status(400).json({ ok: false, error: "session_id required" });
    }

    if (typeof session_id !== "string" || (identity_id != null && (!Number.isSafeInteger(identity_id) || identity_id < 1))) {
      return sendProblem(req, res, 400, "Invalid session selection");
    }
    try {
      if (!req.authPrincipal) throw new Error("Missing principal");
      const existing = await getSession(session_id);
      const effectiveIdentity = identity_id ?? (process.env.BARRY_ID ? Number(process.env.BARRY_ID) : undefined);
      if (effectiveIdentity != null && (!Number.isSafeInteger(effectiveIdentity) || effectiveIdentity < 1)) throw new Error("Invalid identity");
      await authorizeSessionExecution(req.authPrincipal, { sessionId: existing?.id, identityId: effectiveIdentity });
    } catch {
      return sendProblem(req, res, 403, "Session mutation forbidden");
    }

    await startSession({
      session_id,
      provider_session_id,
      provider,
      model,
      model_provider,
      mode,
      guarantees: guaranteesOf(guarantees),
      cwd,
      directive,
      transcript_path,
      permission_mode,
      source,
      identity_id,
      name,
      bounds,
      bags, status,
    });
    res.json({ ok: true });
    // Flush the acknowledgement before any synchronous work in preparation.
    // The next event-loop turn still prepares this exact row eagerly.
    if (mode === "hosted" && status === "pending") setImmediate(() => {
      void residentSession(session_id, req.authPrincipal).then(() => sessionRuntime.warmHarness(session_id)).catch(error => log.warn("session.prepare_failed", { sessionId: session_id, error: String(error) }));
    });
  } catch (error) {
    // Validation (schema rejection or a BarryError marked `invalid`) is the
    // caller's bug — 400 with the message so they can fix it. Anything else is
    // a server fault; answer 500 and keep the raw message (SQL text, paths)
    // out of the response. See ./start-session-errors.ts.
    if (isStartValidationError(error)) {
      return sendProblem(req, res, 400, "Invalid session start request", error instanceof Error ? error.message : String(error));
    }
    log.error("sessions.start_failed", { error: error instanceof Error ? error.message : String(error) });
    return sendProblem(req, res, 500, "Failed to start session");
  }
});

// End a session (called by SessionEnd hook)
routes.route(sessionsRoutes.endNativeSession, async (req, res) => {
  try {
    const session_id = req.body.session_id ?? req.body.sessionId;
    const reason = req.body.reason;

    if (!session_id) {
      return res.status(400).json({ ok: false, error: "session_id required" });
    }

    try {
      if (!req.authPrincipal || typeof session_id !== "string") throw new Error("Missing selection");
      await authorizeSessionExecution(req.authPrincipal, { sessionId: session_id });
    } catch (error) {
      if (error instanceof SessionExecutionResourceUnavailable) return sendProblem(req, res, 404, "Session not found");
      return sendProblem(req, res, 403, "Session mutation forbidden");
    }
    await endSession({ session_id, reason });
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

// Search messages across all sessions (fuzzy)
routes.route(sessionsRoutes.searchSessions, async (req, res) => {
  try {
    const query = req.query.q as string;
    if (!query || query.trim().length < 2) {
      return res.status(400).json({ ok: false, error: "Query must be at least 2 characters" });
    }

    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 50);
    const sessionId = req.query.session_id as string | undefined;
    const role = req.query.role as "user" | "assistant" | undefined;

    const rows = await searchMessages(query.trim(), { session_id: sessionId, role, limit });

    const results = rows.map((r) => ({
      sessionId: r.session_id,
      sequence: r.sequence,
      role: r.role,
      contentSnippet: r.content_snippet,
      createdAt: r.created_at,
      sessionName: r.session_name,
      sessionRepoPath: r.session_repo_path,
      similarityScore: r.similarity_score,
    }));

    res.json({ ok: true, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

// Archive a session
routes.route(sessionsRoutes.archiveSessionLegacy, async (req, res) => {
  try {
    if (!req.authPrincipal) throw new Error("Missing principal");
    await authorizeSessionExecution(req.authPrincipal, { sessionId: req.params.sessionId });
  } catch (error) {
    if (error instanceof SessionExecutionResourceUnavailable) return sendProblem(req, res, 404, "Session not found");
    return sendProblem(req, res, 403, "Session mutation forbidden");
  }
  try {
    await archiveSession(req.params.sessionId);
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

routes.route(sessionsRoutes.getSession, async (req, res) => {
  try {
    const session = await getSession(req.params.sessionId);
    if (!session) {
      return res.status(404).type("application/problem+json").json({ type: "about:blank", title: "Session not found", status: 404, instance: req.originalUrl });
    }
    const [progress, liveProcess] = await Promise.all([
      Events.getLatestBySession(session.id, "progress"),
      Processes.getLive(session.id),
    ]);
    const isLive = sessionRuntime.getActiveSessionIds().includes(session.id);
    res.json(serializeSession(session, liveProcess, undefined, progress, isLive));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

/** Re-scope live sessions on an identity and return the actual invalidation count; see docs/decisions/0020-session-route-and-cache-invariants.md. */
sessionsRouter.post("/invalidate-tools", async (req, res) => {
  const { identityId } = (req.body ?? {}) as { identityId?: unknown };
  if (identityId === undefined || identityId === null || identityId === "") {
    return res.status(400).json({ ok: false, error: "identityId is required" });
  }

  const selectedIdentity = typeof identityId === "number" ? identityId
    : typeof identityId === "string" && /^[1-9][0-9]*$/.test(identityId) ? Number(identityId) : NaN;
  if (!Number.isSafeInteger(selectedIdentity) || selectedIdentity < 1) {
    return sendProblem(req, res, 400, "Invalid identity selection");
  }
  const principal = req.authPrincipal;
  if (!principal) return sendProblem(req, res, 403, "Session mutation forbidden");
  try {
    if (!await revalidateRequestAuthorization(req)) throw new Error("Missing authorization");
    await authorizeSessionExecution(principal, { identityId: selectedIdentity });
  } catch {
    return sendProblem(req, res, 403, "Session mutation forbidden");
  }

  let invalidated = 0;
  for (const sessionId of sessionRuntime.getActiveSessionIds()) {
    const session = await getSession(sessionId).catch(() => undefined);
    if (session && session.identity_id === selectedIdentity) {
      try {
        await authorizeSessionExecution(principal, { sessionId });
      } catch { continue; }
      if (!await revalidateRequestAuthorization(req)) return sendProblem(req, res, 403, "Session mutation forbidden");
      sessionRuntime.invalidateSessionTools(sessionId);
      invalidated += 1;
    }
  }
  res.json({ ok: true, invalidated });
});
