import { timingHeader } from "../runtime/timing.js";
import {identityRecords, owner} from "@barry-rocks/identities-bag";
import {Barry, requestCaller, type Bound} from "@barry-rocks/sdk";
import type { AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import {createLogger} from "@barry-rocks/sdk/logging";
import {sessionsRoutes} from "@barry-rocks/sdk/internal/routes";
import {serve} from "@barry-rocks/sdk/services/http";
import {getAttachment, listAttachments, saveAttachment} from "@barry-rocks/sessions-bag/attachments";
import {authorizeSessionExecution, SessionExecutionResourceUnavailable} from "@barry-rocks/sessions-bag/execution-authorization";
import express, { Router } from "express";
import {hostname} from "os";
// Prompt delivery goes through the session seam, not the db package: these
// tables live in the SQLite store the service owns, and reaching past the
// client would queue into a store nothing drains.
import {Processes, Sessions} from "@barry-rocks/sessions-bag/client";
import {endSession as endSessionLifecycle} from "@barry-rocks/sessions-bag/lifecycle";
import {ExecutionConflict} from "@barry-rocks/sessions-bag/store/turn-continuations";
import {appendMessage, buildSessionHistoryContext, getMessageDetail, getSessionMessages, getSessionRecord, listSessionRecords, updateSessionMetadata, updateSessionRecord} from "../db.js";
import {parseRequestBody, sendProblem} from "../http.js";
import {sessionMcpServers} from "../mcp-config.js";
import {expandUserPath, validateRepoPath} from "../repo-paths.js";
import {inSessionOrder} from "../session-appends.js";
import {buildMcpConfig, sessionRuntime} from "../session-runtime.js";
import {serializeSession} from "../session-serialize.js";
import {pendingTurnRulings, residentSession, submitTurnRuling} from "../turn-execution.js";
import {removeWorktree} from "../worktree.js";

const log = createLogger("barry-server");

import {registerPersistRoutes} from "./session-lifecycle-persist.js";
import {registerSendMessageRoute} from "./session-lifecycle-send.js";
import {registerToolRoutes} from "./session-lifecycle-tools.js";
import {registerBackfillRoute} from "./session-lifecycle-backfill.js";
/**
 * Point-guard worktrees are owned by its verification + merge queue: a direct
 * merge here would land an UNVERIFIED candidate (and the discard twin force-
 * removes evidence). Returns true after sending 409 — the state forbids it, not
 * the caller — so the caller does `if (refuseIfPointGuardOwned(ps, res)) return;`.
 * One definition rather than the block copied into merge and discard.
 */
function refuseIfPointGuardOwned(ps: { metadata?: Record<string, unknown> }, res: express.Response): boolean {
  if (ps.metadata?.source !== "point-guard") return false;
  res.status(409).json({
    ok: false,
    error: "Worktree is owned by point-guard; use its merge queue (confirm-merge) instead",
  });
  return true;
}

export const sessionLifecycleRouter = Router();
const routes = serve(sessionLifecycleRouter, "/sessions", { casing: "camel" });
export function sessionIdParam(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(raw);
}
for (const parameter of ["id", "sessionId"]) {
  sessionLifecycleRouter.param(parameter, (req, res, next, value: unknown) => {
    if (!sessionIdParam(value)) return sendProblem(req, res, 400, "Invalid session id");
    next();
  });
}
sessionLifecycleRouter.use(async (req, res, next) => {
  // Collection creation has no member id and enforces its own identity admission.
  if (req.path === "/" || req.path === "") return next();
  const raw = /^\/([^/]+)(?:\/|$)/.exec(req.path)?.[1];
  let id: unknown;
  try { id = raw === undefined ? undefined : decodeURIComponent(raw); }
  catch { return sendProblem(req, res, 400, "Invalid session id"); }
  if (!sessionIdParam(id)) return sendProblem(req, res, raw === undefined ? 403 : 400, "Invalid session id");
  if (!req.authPrincipal || req.method === "GET" || req.method === "HEAD") return next();
  try {
    if (!await getSessionRecord(id)) return sendProblem(req, res, 404, "Session not found");
    await authorizeSessionExecution(req.authPrincipal, { sessionId: id });
    next();
  } catch (error) {
    if (error instanceof SessionExecutionResourceUnavailable) return sendProblem(req, res, 404, "Session not found");
    sendProblem(req, res, 403, "Session execution forbidden", "The authenticated user cannot control this session.");
  }
});

/**
 * Read an optional `identityId` query param.
 *
 * An absent param and an empty one mean the same thing — no barry chosen —
 * because that is what a form sends when its picker sits on "inherit". Only a
 * present-but-unparseable value is an error; silently treating it as "no barry"
 * would answer a typo with the full list and look like the scoping had failed.
 */
export function parseIdentityIdParam(
  raw: unknown,
): { ok: true; identityId: number | null } | { ok: false } {
  if (raw === undefined) return { ok: true, identityId: null };
  if (typeof raw !== "string") return { ok: false };
  if (raw.trim() === "") return { ok: true, identityId: null };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return { ok: false };
  return { ok: true, identityId: parsed };
}

function recordingPending(sessionId:string):boolean {
  return sessionRuntime.pendingPersistence(sessionId).length>0 || (sessionRuntime.drainingSessions?.has(sessionId)??false);
}

// List and member reads belong to sessionsRouter, mounted first in index.ts.
// Lifecycle routes accept working directories without requiring a git repository.
// See docs/decisions/0035-session-route-and-summary-rationale.md.

routes.route(sessionsRoutes.listMessages, async (req, res) => {
  // Wall-clock for the failure log below. A read that dies at ~5s hit the
  // session-store transport deadline; one that dies instantly did not, and the
  // two want completely different investigations. Without the duration the
  // message ("aborted due to timeout") is the same either way.
  const startedAt = Date.now();
  try {
    const sessionId = req.params.sessionId;
    const after = req.query.after !== undefined ? (Number.isSafeInteger(Number(req.query.after)) ? Number(req.query.after) : undefined) : undefined;
    const before = req.query.before !== undefined ? parseInt(req.query.before as string, 10) : undefined;
    const limit = req.query.limit !== undefined ? parseInt(req.query.limit as string, 10) : 5000;

    const ps = await getSessionRecord(sessionId);
    if (!ps) {
      return res.status(404).json({ ok: false, error: "Session not found" });
    }

    const summary = req.query.summary === "1" || req.query.summary === "true";

    const durable = await sessionRuntime.flushPersistence(sessionId);
    const page = await getSessionMessages(sessionId, {
      afterSequence: Number.isNaN(after) ? undefined : after,
      beforeSequence: Number.isNaN(before) ? undefined : before,
      // Clamp to [1, 5000]: a negative or zero limit reached the DB layer as a
      // nonsense fetch, and 10k-row pages defeated the point of paging.
      limit: Number.isNaN(limit) ? 5000 : Math.max(1, Math.min(limit, 5000)),
      summary,
    });

    const messages=page.messages;let hasMore=page.hasMore;
    if (!durable) {
      const pending=sessionRuntime.pendingPersistence(sessionId);
      for (const frame of pending) {
        if (frame.type === "tool_result") {
          const call=messages.find(row=>row.toolUseId===frame.toolUseId && row.type==="tool_start");
          if (call) { call.result=frame.result; call.status=frame.status; }
        } else if (frame.sequence !== undefined && (after === undefined || frame.sequence>after) && (before === undefined || frame.sequence<before) && !messages.some(row=>row.sequence===frame.sequence)) messages.push(Object.fromEntries(Object.entries({
          ...frame, sessionId, createdAt: frame.createdAt??new Date().toISOString(),
          ...(typeof frame.metadata?.clientMessageId==="string" ? {clientMessageId:frame.metadata.clientMessageId,deliveryState:frame.metadata.delivery==="queued"?"queued":"accepted"} : {}),
        }).filter(([key])=>["type","sessionId","sequence","dedupeKey","role","content","name","input","result","error","status","taskStatus","toolUseId","parentToolUseId","createdAt","clientMessageId","deliveryState"].includes(key))));
      }
      messages.sort((a,b)=>Number(a.sequence)-Number(b.sequence));
      const bounded=Number.isNaN(limit) ? 5000 : Math.max(1,Math.min(limit,5000));
      if (messages.length>bounded) {hasMore=true;messages.splice(after===undefined ? 0 : bounded, messages.length-bounded);}
      res.setHeader("X-Barry-Durability", "pending");
    }
    const nextSequence = messages.length > 0 ? messages[messages.length - 1].sequence : null;
    res.json({ messages, nextSequence, hasMore, durable });
  } catch (err) {
    // Keep query context in the error message to avoid unbounded log-field cardinality.
    const shape = `limit=${req.query.limit ?? "-"} summary=${req.query.summary ?? "-"}`;
    log.error("sessions.messages_failed", {
      sessionId: req.params.sessionId,
      error: `${err instanceof Error ? err.message : String(err)} (${shape})`,
      // Preserve the existing elapsed-time field.
      duration: Date.now() - startedAt,
    });
    res.status(500).json({ ok: false, error: "Failed to get session messages" });
  }
});

routes.route(sessionsRoutes.getMessageDetail, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const sequence = parseInt(req.params.sequence, 10);

    if (Number.isNaN(sequence)) {
      return res.status(400).json({ ok: false, error: "Invalid sequence number" });
    }

    const detail = await getMessageDetail(sessionId, sequence);
    if (!detail) {
      return res.status(404).json({ ok: false, error: "Message not found" });
    }

    res.json({ ok: true, input: detail.input, result: detail.result });
  } catch (err) {
    log.error("sessions.message_detail_failed", { sessionId: req.params.sessionId, sequence: req.params.sequence, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to get message detail" });
  }
});

registerPersistRoutes(routes);


routes.route(sessionsRoutes.getSessionContext, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;

    const ps = await getSessionRecord(sessionId);
    if (!ps) {
      return res.status(404).json({ ok: false, error: "Session not found" });
    }

    const context = await buildSessionHistoryContext(sessionId);

    if (!context) {
      return res.json({ ok: true, context: null, message: "No context available yet" });
    }

    res.json({ ok: true, context });
  } catch (err) {
    log.error("sessions.context_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to get session context" });
  }
});

routes.route(sessionsRoutes.compactSession, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;

    const ps = await getSessionRecord(sessionId);
    if (!ps) {
      return res.status(404).json({ ok: false, error: "Session not found" });
    }

    const activePs = sessionRuntime.getActiveSession(sessionId);

    if (!activePs || !activePs.session) {
      return res.status(400).json({
        ok: false,
        error: "Session does not have an active session. Compaction is only available for sessions with active sessions. Start the session first by sending a message."
      });
    }

    try {
      log.info("sessions.compaction_requested", { sessionId, sdkSessionId: activePs.sessionId });

      // Compaction is a Session capability (SES-22): the adapter defines
      // `compact()` only where the harness supports it. Where it does not
      // (codex, cursor, opencode today), answer 501 rather than sending a
      // literal `/compact` that the harness records as a user message.
      const session = activePs.session;
      if (!session || typeof session.compact !== "function") {
        return res.status(501).json({
          ok: false,
          error: "This session's adapter does not support compaction.",
        });
      }

      await session.compact();

      res.json({
        ok: true,
        message: "Compaction requested. The SDK will compact conversation history if needed.",
        sessionId: activePs.sessionId
      });
    } catch (compactErr) {
      log.error("sessions.compaction_failed", {
        sessionId,
        error: compactErr instanceof Error ? compactErr.message : String(compactErr)
      });
      res.status(500).json({
        ok: false,
        error: "Compaction failed: " + (compactErr instanceof Error ? compactErr.message : String(compactErr))
      });
    }
  } catch (err) {
    log.error("sessions.compact_endpoint_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to compact session context" });
  }
});

routes.route(sessionsRoutes.archiveSession, async (req, res) => {
  try {
    const ps = await getSessionRecord(req.params.sessionId);

    if (!ps) {
      return res.status(404).json({ ok: false, error: "Session not found" });
    }

    if (sessionRuntime.getActiveSession(req.params.sessionId)) {
      await sessionRuntime.removeSession(req.params.sessionId, req.authPrincipal);
    } else {
      await endSessionLifecycle({ session_id: req.params.sessionId, reason: "removed" });
    }

    if(recordingPending(req.params.sessionId)){
      return res.json({ok:true,message:"Session removed; transcript still draining",recordingPending:true});
    }
    await updateSessionRecord(req.params.sessionId, { status: "cancelled", completed_at: new Date() });

    res.json({ ok: true, message: "Session removed" });
  } catch (err) {
    log.error("sessions.remove_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to remove session" });
  }
});

/**
 * Start a session that was just created, with its first message.
 *
 * Deliberately NOT a general "send a message" — that is `POST /:id/message`, 262
 * lines covering cases this one provably cannot be in. The session was created
 * microseconds ago by the only caller of this function, so:
 *
 *  - it has no prior messages, so there is no `clientMessageId` conflict and no
 *    failed prompt to re-claim;
 *  - it has no external driver, so the "active elsewhere, queue instead of
 *    starting" branch cannot apply — nothing has had the chance to attach;
 *  - it is not in the SDK manager's active map, so the follow-up-message branch
 *    cannot apply either.
 *
 * What remains is the fresh-start path: validate the working directory, resolve
 * traits into an MCP config, hand both to `sessionRuntime.startSession`. Reusing
 * the message route instead would mean either a self-HTTP call (auth headers and
 * port discovery for a request to ourselves) or extracting 262 lines of delivery
 * logic mid-change — in the subsystem where this session already fixed hollow
 * payloads and dropped rows. Neither is worth it for a path with three live
 * branches.
 *
 * Returns rather than throws, so the caller can answer 201-created-but-not-started
 * instead of claiming an agent is running when it is not.
 */
async function startSessionWithFirstMessage(
  sessionId: string,
  prompt: string,
  ps: { identity_id?: number | null; bags?: string[]; bounds?: Array<Bound | string>; bound?: Record<string, unknown> | null; metadata?: Record<string, unknown> },
  principal?: AuthPrincipal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const workDir = ps.metadata?.working_directory as string | undefined;
  if (!workDir) {
    return { ok: false, error: "Session has no working directory, so it cannot be started. Supply repoPath." };
  }
  const validated = validateRepoPath(workDir);
  if (!validated.ok) return { ok: false, error: validated.error };

  try {
    const caller = requestCaller(principal);
    const bagNames = ps.bags ?? [];
    let tools: Awaited<ReturnType<typeof Barry.tools>> = [];
    try {
      tools = await Barry.as(caller).tools(
        ps.identity_id ?? null,
        bagNames,
        (ps.bound as Bound | null) ?? ps.bounds ?? [],
      );
    } catch {
      tools = [];
    }
    await sessionRuntime.startSession({
      sessionId,
      prompt,
      repoPath: validated.path,
      bags: bagNames.length > 0 ? bagNames : undefined,
      bounds: ps.bounds ?? [],
      bound: (ps.bound as Bound | null) ?? undefined,
      mcpServers: await sessionMcpServers(sessionId, tools),
      useWorktree: !!ps.metadata?.use_worktree,
      provider: (ps.metadata?.provider as string) || undefined,
      model: (ps.metadata?.model as string) || undefined,
      modelProvider: (ps.metadata?.model_provider as string) || undefined,
    }, principal);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Create a session and start it only when a prompt is supplied.
 * Callers can omit the prompt to subscribe before the agent produces output.
 * See docs/decisions/0035-session-route-and-summary-rationale.md.
 */
routes.route(sessionsRoutes.createSession, async (req, res) => {
  try {
    const input = parseRequestBody(req, res, sessionsRoutes.createSession.body);
    if (!input) return;
    const { systemPrompt, prompt, repoPath, name, bags, identityId, useWorktree, provider, model, modelProvider, bounds, bound, reviewPolicy, reviewRules } = input;
    const activeBags = bags ?? [];

    const metadata: Record<string, unknown> = {};
    let resolvedRepoPath: string | null = null;
    if (repoPath) {
      const validated = validateRepoPath(repoPath);
      if (!validated.ok) {
        return sendProblem(req, res, 400, "Invalid repository path", validated.error);
      }
      metadata.working_directory = validated.path;
      resolvedRepoPath = validated.path;
    }
    if (name) metadata.name = name;
    if (useWorktree) metadata.use_worktree = true;
    if (provider) metadata.provider = provider;
    if (model) metadata.model = model;
    if (modelProvider) metadata.model_provider = modelProvider;
    metadata.review_policy = reviewRules ?? reviewPolicy ?? { mode: "review_required" };

    const user = req.authPrincipal ? await owner.users.get(req.authPrincipal.actorId) : await owner.current();
    if (!user) return sendProblem(req, res, 400, "No Barry user is configured");
    const selection = await identityRecords.resolve({ id: identityId, repoPath: resolvedRepoPath }, requestCaller(req.authPrincipal));
    metadata.barry_source = selection.source;

    const effectiveIdentityId = (await identityRecords.rowId(selection.barry, { actorId: user.id })) ?? undefined;
    const requestedBounds: Array<Bound | string> = [
      ...(bounds ?? []),
      ...(bound ? [bound as Bound] : []),
    ];
    let pinnedBound: Bound | null = bound ? (bound as Bound) : null;
    if (requestedBounds.length > 0) {
      try {
        pinnedBound = await Barry.as(requestCaller(req.authPrincipal)).bound(
          selection.barry.id,
          requestedBounds,
        );
      } catch (error) {
        return sendProblem(req, res, 400, "Unknown bound", String(error));
      }
    } else {
      try {
        pinnedBound = await Barry.as(requestCaller(req.authPrincipal)).bound(selection.barry.id, []);
      } catch {
        // Fallback when identity subject is not wired in isolated unit tests.
      }
    }

    const ps = await Sessions.createInert({
      user_id: user.id,
      system_prompt: systemPrompt,
      bags: activeBags,
      // A file-based Barry's id is a name hash with no matching row; this
      // syncs its cache row and returns an id the FK accepts.
      identity_id: effectiveIdentityId,
      bounds: bounds ?? [],
      bound: pinnedBound,
      metadata,
    });

    const running = await listSessionRecords({ status: "running", limit: 100 });
    const pending = await listSessionRecords({ status: "pending", limit: 100 });
    const activeCount = running.length + pending.length;

    if (activeCount >= 10) res.setHeader("Warning", `199 barry "You have ${activeCount} active sessions"`);

    // RFC 9110 §10.2.2: a 201 names the created resource in `Location`. Set once
    // here rather than at each of the three 201 returns below, because all three
    // created the SAME session — only whether its agent started differs, and a
    // failed start does not make the resource less created or its URL less valid.
    //
    // Relative on purpose. This service is reached through several hostnames (a
    // proxy, a local name, 127.0.0.1) and reconstructing an absolute URL
    // from the request would hand callers whichever one this hop happened to see.
    // §10.2.2 permits a relative reference, and every client here resolves it
    // against the request URL.
    res.setHeader("Location", `${req.baseUrl}/${ps.id}`);

    // `prompt` folds the old two-call spawn into one.
    //
    // It dispatches to THIS router's own `POST /:id/message` rather than
    // reimplementing the send. That handler is 262 lines of message-delivery
    // logic — clientMessageId idempotency, failed-prompt retry claiming, process
    // liveness classification, and the queue-vs-start decision for a session an
    // external `barry start` already drives. A second copy of that would be a
    // second set of delivery bugs, in the subsystem where hollow payloads and
    // dropped rows have already cost real data.
    //
    // 201 is still the answer either way: the session was created, which is what
    // the status code describes. A start failure is reported in the body so the
    // caller is not told the agent is running when it is not.
    if (prompt) {
      const started = await startSessionWithFirstMessage(ps.id, prompt, ps, req.authPrincipal);
      if (!started.ok) {
        return res.status(201).json({
          ...serializeSession(ps, await Processes.getLive(ps.id)),
          started: false,
          startError: started.error,
        });
      }
      const fresh = await getSessionRecord(ps.id);
      return res.status(201).json({ ...serializeSession(fresh ?? ps, await Processes.getLive(ps.id)), started: true });
    }

    res.status(201).json(serializeSession(ps, await Processes.getLive(ps.id)));
  } catch (err) {
    log.error("sessions.create_failed", { error: err instanceof Error ? err.message : String(err) });
    sendProblem(req, res, 500, "Failed to create session");
  }
});

routes.route(sessionsRoutes.updateSession, async (req, res) => {
  try {
    const ps = await getSessionRecord(req.params.sessionId);

    if (!ps) {
      return sendProblem(req, res, 404, "Session not found");
    }

    const input = parseRequestBody(req, res, sessionsRoutes.updateSession.body);
    if (!input) return;
    const { repoPath, systemPrompt, name, bags, bound, bounds, pinned, identityId, selectedNamespaces, selectedTools, provider, model, modelProvider, reviewPolicy, reviewRules, pid, pidStartedAt, command, processName, appName, parentPid, prepare, metadata } = input;
    const activeBags = bags;

    let pinnedBound: Bound | null | undefined = undefined;
    if (bounds !== undefined) {
      const effectiveIdentity = identityId !== undefined ? identityId : ps.identity_id;
      const requestBound = bound === undefined ? ps.bound : bound;
      const requestedBounds: Array<Bound | string> = [
        ...bounds,
        ...(requestBound ? [requestBound as Bound] : []),
      ];
      try {
        pinnedBound = await Barry.as(requestCaller(req.authPrincipal)).bound(
          effectiveIdentity ?? null,
          requestedBounds,
        );
      } catch (error) {
        return sendProblem(req, res, 400, "Unknown bound", String(error));
      }
    }

    // Update metadata fields atomically (read-merge-write in a transaction)
    const metadataUpdates: Record<string, unknown> = {};
    if (repoPath !== undefined) {
      const validated = validateRepoPath(repoPath);
      if (!validated.ok) {
        return sendProblem(req, res, 400, "Invalid repository path", validated.error);
      }
      metadataUpdates.working_directory = validated.path;
    }
    if (name !== undefined) metadataUpdates.name = name;
    if (pinned !== undefined) metadataUpdates.pinned = pinned;
    if (selectedNamespaces !== undefined) metadataUpdates.selected_namespaces = selectedNamespaces;
    if (selectedTools !== undefined) metadataUpdates.selected_tools = selectedTools;
    if (provider !== undefined) metadataUpdates.provider = provider;
    if (model !== undefined) metadataUpdates.model = model;
    if (modelProvider !== undefined) metadataUpdates.model_provider = modelProvider;
    if (metadata?.effort !== undefined) metadataUpdates.effort = metadata.effort;
    if (reviewRules !== undefined || reviewPolicy !== undefined) metadataUpdates.review_policy = reviewRules ?? reviewPolicy;

    if (Object.keys(metadataUpdates).length > 0) {
      await Sessions.updateMetadataNormalized(req.params.sessionId, metadataUpdates);
    }

    // Authoritative process tracking writes to the processes table rather than metadata.
    if (pid !== undefined) {
      if (pid !== null) {
        await Processes.recordStart({
          sessionId: req.params.sessionId,
          pid,
          pidStartedAt: pidStartedAt ?? null,
          hostname: hostname(),
          command: command ?? null,
          processName: processName ?? null,
          appName: appName ?? null,
          parentPid: parentPid ?? null,
          source: "cli",
        });
      } else {
        await Processes.markEnded(req.params.sessionId, "cli_exit");
      }
    }

    const updates: Record<string, unknown> = {};
    if (systemPrompt !== undefined) updates.system_prompt = systemPrompt;
    if (activeBags !== undefined) updates.bags = activeBags;
    if (bounds !== undefined) {
      updates.bounds = bounds;
      updates.bound = pinnedBound;
    } else if (bound !== undefined) {
      updates.bound = bound;
    }
    if (identityId !== undefined || (repoPath !== undefined && ps.metadata?.barry_source !== "explicit")) {
      const effectiveRepoPath = repoPath !== undefined
        ? metadataUpdates.working_directory as string
        : ps.metadata?.working_directory as string | undefined;
      const resolved = await identityRecords.resolve(
        { id: identityId === undefined ? null : identityId, repoPath: effectiveRepoPath },
        requestCaller(req.authPrincipal),
      );
      updates.identity_id = await identityRecords.rowId(resolved.barry);
      await Sessions.updateMetadataNormalized(req.params.sessionId, { barry_source: resolved.source });
    }

    if (Object.keys(updates).length > 0) {
      await updateSessionRecord(req.params.sessionId, updates);
    }

    const resident = sessionRuntime.getActiveSession(req.params.sessionId);
    if (resident && metadata?.effort !== undefined) {
      resident.effort = metadata.effort ?? resident.identityEffort;
    }
    const changedConfiguration = resident && (
      (provider !== undefined && provider !== resident.provider) ||
      (model !== undefined && model !== resident.model) ||
      (modelProvider !== undefined && modelProvider !== resident.modelProvider) ||
      (repoPath !== undefined && repoPath !== resident.repoPath) ||
      (identityId !== undefined && identityId !== resident.identityId)
    );
    if (changedConfiguration && (resident.warm || resident.warming)) {
      const previous = await sessionRuntime.dropResident(req.params.sessionId);
      if (previous) {
        const replacement = await residentSession(req.params.sessionId, req.authPrincipal);
        for (const subscriber of previous.subscribers) replacement.subscribers.add(subscriber);
        void sessionRuntime.warmHarness(replacement.id);
        log.info("session.warm_miss", { sessionId: replacement.id, reason: "configuration_changed" });
      }
    }
    // If bags, bounds, or tool config changed, invalidate the active SDK session so
    // the next turn re-creates MCP connections with the updated bound.
    if (activeBags !== undefined || bounds !== undefined || bound !== undefined || selectedNamespaces !== undefined || selectedTools !== undefined) {
      sessionRuntime.invalidateSessionTools(req.params.sessionId, {reason: "grants"});
    }
    if (systemPrompt !== undefined) sessionRuntime.invalidateSessionTools(req.params.sessionId, {reason: "system_prompt"});

    const updated = await getSessionRecord(req.params.sessionId);
    if (!updated) return sendProblem(req, res, 404, "Session not found");
    if (prepare) { await residentSession(updated.id, req.authPrincipal); void sessionRuntime.warmHarness(updated.id); }
    res.json(serializeSession(updated, await Processes.getLive(updated.id)));
  } catch (err) {
    log.error("sessions.update_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
    sendProblem(req, res, 500, "Failed to update session");
  }
});

routes.route(sessionsRoutes.stopSession, async (req, res) => {
  try {
    const ps = await getSessionRecord(req.params.sessionId);

    if (!ps) {
      return res.status(404).json({ ok: false, error: "Session not found" });
    }

    if (sessionRuntime.getActiveSession(req.params.sessionId)) {
      await sessionRuntime.stopSession(req.params.sessionId, req.authPrincipal);
    } else if (ps.status !== "completed") {
      // Not in memory: the process is already gone, so end the lifecycle rather
      // than only stamping the status. Writing status alone would leave
      // active=true and state=open, which is the shape that made closed
      // sessions keep reporting as live.
      await endSessionLifecycle({ session_id: req.params.sessionId, reason: "stopped" }).catch((err) => {
        log.warn("sessions.stop_end_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
      });
    }

    res.json({ ok: true, message: "Session stopped", recordingPending:recordingPending(req.params.sessionId) });
  } catch (err) {
    log.error("sessions.stop_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to stop session" });
  }
});

// POST /sessions/:id/interrupt - End the running turn; the session stays open
routes.route(sessionsRoutes.interruptSession, async (req, res) => {
  try {
    const ps = await getSessionRecord(req.params.sessionId);
    if (!ps) {
      return res.status(404).json({ ok: false, error: "Session not found" });
    }
    const control=sessionRuntime.getActiveSession(req.params.sessionId)?.turnControl;
    const interrupted = await sessionRuntime.interruptTurn(req.params.sessionId, req.authPrincipal);
    const forced=control?.force.signal.aborted===true;
    res.json({ ok: true, status:interrupted?(forced?"forced":"interrupted"):"none", message: interrupted ? (forced?"Turn forced to stop":"Turn interrupted") : "No turn was running" });
  } catch (err) {
    log.error("sessions.interrupt_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "Failed to interrupt the turn" });
  }
});

// POST /sessions/:id/attach - Open the hosted session to a TUI the caller launches
routes.route(sessionsRoutes.prepareSession, async (req, res) => {
  const id = req.params.sessionId;
  try {
    const row = await getSessionRecord(id);
    if (!row) return sendProblem(req, res, 404, "Session not found");
    const active = await residentSession(id, req.authPrincipal);
    void sessionRuntime.warmHarness(id);
    res.setHeader("X-Barry-Timing", timingHeader({ ...active.timings, warm_hit: active.session?.isWarm?.() === true ? 1 : 0 }));
    return res.status(202).json({ ok: true });
  } catch (error) {
    if (error instanceof ExecutionConflict) return sendProblem(req, res, 409, "Session is driven elsewhere", error.message);
    log.warn("session.prepare_failed", { sessionId: id, error: String(error) });
    return sendProblem(req, res, 500, "Could not prepare session");
  }
});

routes.route(sessionsRoutes.attachRenderer, async (req, res) => {
  const input = parseRequestBody(req, res, sessionsRoutes.attachRenderer.body);
  if (!input) return;
  const sessionId = req.params.sessionId;
  try {
    if (!(await getSessionRecord(sessionId))) return sendProblem(req, res, 404, "Session not found");
    await residentSession(sessionId, req.authPrincipal);
    res.json(await sessionRuntime.attachRenderer(sessionId, input.launcherPid, req.authPrincipal));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error("sessions.attach_failed", { sessionId, error: detail });
    if (err instanceof ExecutionConflict) return sendProblem(req, res, 409, "Session is driven elsewhere", detail);
    sendProblem(req, res, 500, "Failed to attach to the session", detail);
  }
});

// POST /sessions/:id/detach - End one attachment; the session stays open
routes.route(sessionsRoutes.detachRenderer, async (req, res) => {
  const input = parseRequestBody(req, res, sessionsRoutes.detachRenderer.body);
  if (!input) return;
  try {
    const detached = await sessionRuntime.detachRenderer(req.params.sessionId, input.attachmentId, req.authPrincipal);
    res.json({ message: detached ? "Detached" : "Already detached", sessionId: req.params.sessionId });
  } catch (err) {
    log.error("sessions.detach_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
    sendProblem(req, res, 500, "Failed to detach from the session");
  }
});

registerSendMessageRoute(routes);


// NOTE: POST /sessions/start is served by sessionsRouter (the SessionStart hook
// endpoint). The web app starts SDK sessions over the WebSocket (`start` message
// → sessionRuntime.startSession), not over HTTP, so the SDK-start handler that used
// to live here was permanently shadowed and unreachable — removed.

routes.route(sessionsRoutes.mergeSessionWorktree, async (req, res) => {
  try {
    const ps = await getSessionRecord(req.params.sessionId);
    if (!ps) return res.status(404).json({ ok: false, error: "Session not found" });

    const worktreePath = ps.metadata?.worktree_path as string | undefined;
    const baseRepoPath = ps.metadata?.base_repo_path as string | undefined;
    const sessionId = req.params.sessionId;

    if (refuseIfPointGuardOwned(ps, res)) return;

    if (!worktreePath || !baseRepoPath) {
      return res.status(400).json({ ok: false, error: "Session has no worktree metadata" });
    }

    const absBaseRepo = expandUserPath(baseRepoPath);
    const absWorktree = expandUserPath(worktreePath);
    const branchName = `barry/${sessionId}`;
    const originalPrompt = ps.system_prompt || "(no prompt)";

    const mergePrompt = `Merge the branch \`${branchName}\` into the current branch of this repo.
The branch was created by a Barry session with this goal: "${originalPrompt}"

Steps:
1. Run: git merge ${branchName}
2. If there are conflicts, resolve them using the context of the original session
3. Verify the merge looks correct
4. Run: git worktree remove ${absWorktree} --force
5. Run: git branch -D ${branchName}
6. Report what was merged and any issues encountered`;

    // No session id yet — this session is created below, so there is nothing for
    // the MCP server to resolve against. Splitting picks up on the next turn.
    const mcpServers = buildMcpConfig();

    const mergeSession = await sessionRuntime.startSession({
      prompt: mergePrompt,
      repoPath: absBaseRepo,
      mcpServers,
      metadata: {
        merge_session_for: sessionId,
        unlisted: false,
      },
    }, req.authPrincipal);

    // Mark original session's worktree as merging. Partial metadata merge
    // rather than read-spread-overwrite, which races with concurrent metadata writers
    // and silently drops whatever keys they wrote after this handler's read.
    await updateSessionMetadata(sessionId, {
      worktree_status: "merging",
      merge_session_id: mergeSession.id,
    });

    res.json({ ok: true, mergeSessionId: mergeSession.id });
  } catch (err) {
    log.error("sessions.merge_worktree_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "Failed to start merge" });
  }
});

routes.route(sessionsRoutes.discardSessionWorktree, async (req, res) => {
  try {
    const ps = await getSessionRecord(req.params.sessionId);
    if (!ps) return res.status(404).json({ ok: false, error: "Session not found" });

    const worktreePath = ps.metadata?.worktree_path as string | undefined;
    const baseRepoPath = ps.metadata?.base_repo_path as string | undefined;
    const sessionId = req.params.sessionId;

    if (refuseIfPointGuardOwned(ps, res)) return;

    if (!worktreePath || !baseRepoPath) {
      return res.status(400).json({ ok: false, error: "Session has no worktree metadata" });
    }

    const absBaseRepo = expandUserPath(baseRepoPath);
    const absWorktree = expandUserPath(worktreePath);

    if (sessionRuntime.getActiveSession(sessionId)) {
      await sessionRuntime.removeSession(sessionId, req.authPrincipal);
    }
    if(recordingPending(sessionId)){
      return res.status(409).json({ok:false,error:"Transcript still draining; retry discard when recording catches up"});
    }
    await removeWorktree(absBaseRepo, absWorktree, sessionId);
    await endSessionLifecycle({ session_id: sessionId, reason: "discarded" });
    await updateSessionRecord(sessionId, { status: "cancelled", completed_at: new Date() });
    // Separate atomic merge — see the merge-worktree handler above.
    await updateSessionMetadata(sessionId, { worktree_status: "discarded" });
    res.json({ ok: true, message: "Worktree discarded" });
  } catch (err) {
    log.error("sessions.discard_worktree_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "Failed to discard worktree" });
  }
});

// `POST /sessions/:id/open-finder` and `/:id/open-editor` were here: HTTP
// endpoints whose entire job was to look up `metadata.working_directory` and
// shell out to `open` or `code`. They read no other session field, had no caller
// in this repo or any installed bag, and are not something a REST resource should
// model — "reveal this folder on the machine running the server" is a desktop
// action, not a property of a session.
//
// They went with the eight git routes (see `session-changes.ts`) for the same
// reason: the session id was a lookup key for a directory, nothing more.



registerToolRoutes(routes);

registerBackfillRoute(routes);


sessionLifecycleRouter.post("/:id/rulings", async (req, res) => {
  const { requestId, decision, reason } = req.body ?? {};
  if (!requestId || typeof requestId !== "string" || !["allow", "deny"].includes(decision)) {
    return res.status(400).json({ ok: false, error: "requestId and decision ('allow' | 'deny') are required" });
  }
  if (!req.authPrincipal) return sendProblem(req, res, 403, "Session approval requires authentication");
  const applied = await submitTurnRuling(req.params.id, requestId, decision, reason, req.authPrincipal);
  return res.json({ ok: true, status: applied ? "applied" : "expired" });
});

sessionLifecycleRouter.get("/:id/rulings", (req, res) => {
  const pending = pendingTurnRulings(req.params.id);
  res.json({ ok: true, pending });
});


sessionLifecycleRouter.post("/:id/attachments", express.json({ limit: "30mb" }), async (req, res) => {
  if (!await getSessionRecord(req.params.id)) return sendProblem(req, res, 404, "Session not found");
  const { name, mimeType, content, base64 } = req.body ?? {};
  if (!name || typeof name !== "string" || !mimeType || typeof mimeType !== "string") {
    return res.status(400).json({ ok: false, error: "name and mimeType are required" });
  }
  const data = base64
    ? Buffer.from(base64, "base64")
    : typeof content === "string"
      ? Buffer.from(content, "utf8")
      : Buffer.isBuffer(content)
        ? content
        : null;

  if (!data) {
    return res.status(400).json({ ok: false, error: "content or base64 data is required" });
  }

  try {
    const attachment = await saveAttachment(req.params.id, { name, mimeType, data });
    try {
      const sessionId = req.params.id;
      await inSessionOrder(sessionId, () => appendMessage(sessionId, {
        type: "attachment",
        content: `Attachment uploaded: ${name}`,
        metadata: { attachment },
      }));
    } catch {
      // Best-effort transcript record: failure to persist transcript does not invalidate the saved attachment blob.
    }
    return res.status(201).json({ ok: true, attachment });
  } catch (err: unknown) {
    const status = typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : 500;
    const message = err instanceof Error ? err.message : String(err);
    return res.status(status).json({ ok: false, error: message });
  }
});

sessionLifecycleRouter.get("/:id/attachments", async (req, res) => {
  if (!await getSessionRecord(req.params.id)) return sendProblem(req, res, 404, "Session not found");
  const attachments = await listAttachments(req.params.id);
  res.json({ ok: true, attachments });
});

sessionLifecycleRouter.get("/:id/attachments/:attachmentId", async (req, res) => {
  if (!await getSessionRecord(req.params.id)) return sendProblem(req, res, 404, "Session not found");
  const full = await getAttachment(req.params.id, req.params.attachmentId);
  if (!full) {
    return res.status(404).json({ ok: false, error: "Attachment not found" });
  }
  if (req.query.download === "1" || req.query.raw === "1") {
    res.setHeader("Content-Type", full.meta.mimeType);
    const ascii = full.meta.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encoded = encodeURIComponent(full.meta.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(full.data);
  }
  res.json({ ok: true, attachment: full.meta });
});
