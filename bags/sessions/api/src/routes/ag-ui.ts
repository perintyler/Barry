import { access, owner } from "@barry-rocks/identities-bag";
import {
	agUiSse, approvalDecisions, barryExtensionsForRun, executionTranscript, parseRunAgentInput,
	type ExecutionEvent,
} from "@barry-rocks/sdk/apps";
import { revalidateRequestAuthorization } from "@barry-rocks/sdk/internal/auth";
import { aguiRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
import { executionHash } from "@barry-rocks/sdk/sessions";
import { authorizeSessionExecution, SessionExecutionResourceUnavailable } from "@barry-rocks/sessions-bag/execution-authorization";
import { ExecutionConflict } from "@barry-rocks/sessions-bag/store/turn-continuations";
import { Router, type Request, type Response } from "express";
import { agUiSnapshot } from "../ag-ui-snapshot.js";
import { getDescribeAdapter } from "../agent-runtime.js";
import { getSessionRecord } from "../db.js";
import { sessionRuntime } from "../session-runtime.js";
import { prepareTurnSession, turnExecutionService } from "../turn-execution.js";
import { sessionReviewPolicy } from "../review-policy.js";
const streams = new Set<Response>();
export function closeAgUiStreams(): void { for (const response of streams) response.end(); streams.clear(); }

function problem(res: Response, error: unknown): void {
  const status = error instanceof ExecutionConflict ? 409 : 400;
  res.status(status).type("application/problem+json").json({ type: "about:blank", title: status === 409 ? "Execution conflict" : "Invalid request", status, detail: error instanceof Error ? error.message : String(error) });
}

function cursor(value: unknown): { sequence: number; index: number } {
  if (value == null || value === "") return { sequence: 0, index: -1 };
  if (typeof value !== "string" || !/^\d+(?::\d+)?$/.test(value)) throw new Error("Invalid event cursor");
  const [sequence, index] = value.split(":").map(Number);
  if (!Number.isSafeInteger(sequence) || (index !== undefined && !Number.isSafeInteger(index))) throw new Error("Invalid event cursor");
  return { sequence: sequence, index: index ?? Number.MAX_SAFE_INTEGER };
}

/** Poll the durable source with bounded pages; no unbounded per-client event queue. */
async function stream(req: Request, res: Response, sessionId: string, after: ReturnType<typeof cursor>, authorizationIntervalMs: number, runId?: string): Promise<void> {
  if (!await revalidateRequestAuthorization(req)) {
    if (!res.destroyed && !res.writableEnded) res.status(403).json({ title: "Stream authorization unavailable", status: 403 });
    return;
  }
  const { store } = turnExecutionService();
  store.replay(sessionId, after.sequence, 1, true);
  res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  streams.add(res);
  let closed = false, pumping = false;
  let timer: NodeJS.Timeout | undefined, authorizationTimer: NodeJS.Timeout | undefined;
  let authorization: Promise<boolean> | undefined;
  let invalidated = false, invalidation: Promise<void> | undefined;
  let unsubscribeAuthorization: (() => void) | undefined;
  const controller = new AbortController();
  let sequence = after.sequence, index = after.index, blocked = false;
  const cleanup = () => {
    if (closed) return;
    closed = true; controller.abort(); streams.delete(res);
    if (timer) clearTimeout(timer);
    if (authorizationTimer) clearTimeout(authorizationTimer);
    unsubscribeAuthorization?.(); unsubscribeAuthorization = undefined;
    res.off("drain", drain); res.off("close", cleanup);
  };
  const finish = () => { cleanup(); if (!res.destroyed && !res.writableEnded) res.end(); };
  const allowed = (): Promise<boolean> => {
    if (closed || res.destroyed || res.writableEnded) { finish(); return Promise.resolve(false); }
    authorization ??= revalidateRequestAuthorization(req, controller.signal).then(valid => {
      if (!valid) finish();
      return valid && !closed;
    }).catch(() => { finish(); return false; }).finally(() => { authorization = undefined; });
    return authorization;
  };
  const checkIdle = async () => {
    if (!await allowed() || closed) return;
    authorizationTimer = setTimeout(() => { void checkIdle(); }, authorizationIntervalMs);
    authorizationTimer.unref();
  };
  const invalidate = () => {
    invalidated = true;
    invalidation ??= (async () => {
      while (invalidated && !closed) { invalidated = false; await allowed(); }
    })().finally(() => { invalidation = undefined; });
  };
  const drain = () => { blocked = false; void pump(); };
  const pump = async () => {
    if (closed || blocked || pumping) return;
    pumping = true;
    let delay = 150;
    try {
      if (!await allowed()) return;
      const records = store.replay(sessionId, sequence, 128, true);
      delay = records.length >= 128 ? 0 : 150;
      for (const record of records) {
        if (closed) return;
        if (record.sequence < sequence) continue;
        const frames = runId && record.runId !== runId ? [] : agUiSse(sessionId, record as ExecutionEvent).split("\n\n").filter(Boolean);
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
          if (record.sequence === sequence && frameIndex <= index) continue;
          if (!await allowed()) return;
          sequence = record.sequence; index = frameIndex;
          blocked = !res.write(`${frames[frameIndex]}\n\n`);
          if (blocked) return;
        }
        sequence = record.sequence; index = Number.MAX_SAFE_INTEGER;
        const type = (record.event as { type: string }).type;
        if (runId && record.runId === runId && (type === "segment_interrupted" || type === "turn_finished")) { finish(); return; }
      }
    } catch { cleanup(); res.destroy(); }
    finally {
      pumping = false;
      if (!closed && !blocked) { timer = setTimeout(() => { void pump(); }, delay); timer.unref(); }
    }
  };
  res.on("close", cleanup); res.on("drain", drain);
  unsubscribeAuthorization = access.subscribe(invalidate);
  authorizationTimer = setTimeout(() => { void checkIdle(); }, authorizationIntervalMs);
  authorizationTimer.unref();
  void pump();
}

export function createAgUiRouter(options: { authorizationIntervalMs?: number } = {}): Router {
  const authorizationIntervalMs = options.authorizationIntervalMs ?? 1000;
  if (!Number.isInteger(authorizationIntervalMs) || authorizationIntervalMs < 10 || authorizationIntervalMs > 10000) throw new RangeError("Invalid stream authorization interval");
  const router = Router();
  const routes = serve(router, "/api/v2/sessions");
  router.use("/:id", async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        if (!req.authPrincipal) throw new Error("Missing authenticated principal");
        await authorizeSessionExecution(req.authPrincipal, { sessionId: req.params.id });
      } catch (error) {
        const status = error instanceof SessionExecutionResourceUnavailable ? 404 : 403;
        res.status(status).json({ title: status === 404 ? "Session not found" : "Session execution forbidden", status });
        return;
      }
    }
    try {
      const session = await getSessionRecord(req.params.id);
      if (!session) { res.status(404).json({ title: "Session not found", status: 404 }); return; }
      res.locals.barrySession = session; next();
    } catch (error) { next(error); }
  });

  routes.route(aguiRoutes.getAgUiSession, async (req, res) => {
    try {
      res.json(await agUiSnapshot(req.params.sessionId));
    } catch (error) { problem(res, error); }
  });

  routes.route(aguiRoutes.subscribeAgUiEvents, async (req, res) => {
    try { await stream(req, res, req.params.sessionId, cursor(req.query.after ?? req.headers["last-event-id"]), authorizationIntervalMs); }
    catch (error) { problem(res, error); }
  });

  routes.route(aguiRoutes.runAgUiAgent, async (req, res) => {
    try {
      const input = parseRunAgentInput(req.body, req.params.sessionId);
      const { attachmentIds, ifActive } = barryExtensionsForRun(input);
      const { store, execution } = turnExecutionService();
      const state = store.publicState(req.params.sessionId);
      const history = executionTranscript(state.inputs, state.events as ExecutionEvent[]);
      const resumed = !!input.resume?.length;
      const previous = store.byRun(req.params.sessionId, input.runId);
      const proposedHistory = resumed ? input.messages : input.messages.slice(0, -1);
      if (!previous && (proposedHistory.length !== history.length || executionHash(proposedHistory) !== executionHash(history))) {
        throw new ExecutionConflict("Client history differs from committed history; refresh the session snapshot");
      }
      const user = req.authPrincipal ? await owner.users.get(req.authPrincipal.actorId) : await owner.current();
      if (!user) throw new Error("No authenticated instance user is configured");
      let turn;
      if (resumed) {
        const active = previous?.turn ?? store.active(req.params.sessionId);
        if (!active) throw new ExecutionConflict("No turn is waiting for input");
        turn = execution.resolve({ sessionId: req.params.sessionId, turnId: active.id, requestId: input.runId, runId: input.runId, actor: `user:${user.id}`, decisions: approvalDecisions(input), context: input });
      } else {
        const message = input.messages.at(-1);
        if (!message || message.role !== "user" || typeof message.content !== "string" || !message.content.trim()) throw new Error("A new run requires a text user message");
        if (previous) {
          if (!previous.initial || executionHash((previous.input as { request: unknown }).request) !== executionHash(input)) throw new ExecutionConflict("Run identity was reused with different input");
          res.set("X-Barry-Turn-Id", previous.turn.id);
          await stream(req, res, req.params.sessionId, { sequence: 0, index: -1 }, authorizationIntervalMs, input.runId);
          return;
        }
        if (store.active(req.params.sessionId) && ifActive !== "queue") throw new ExecutionConflict("Session already has an active turn");
        const active = await prepareTurnSession(req.params.sessionId, req.authPrincipal);
        const hosted = getDescribeAdapter()?.(active.provider)?.modes.hosted;
        const continuation = hosted?.approvalContinuation;
        if ((continuation !== "durable" && continuation !== "live") || hosted?.guarantees.gating !== "per-call") throw new ExecutionConflict("This adapter cannot provide per-call approval runs");
        const policy = sessionReviewPolicy(res.locals.barrySession.metadata?.review_policy);
        const prefix = attachmentIds.length ? await sessionRuntime.prepareTurnAttachments(active, attachmentIds) : "";
        turn = execution.admit({ sessionId: req.params.sessionId, requestId: input.runId, runId: input.runId, actor: `user:${user.id}`, content: { text: prefix ? `${prefix}\n\n${message.content}` : message.content, message, request: input, attachmentIds }, policy, ...(ifActive ? { ifActive } : {}) });
      }
      res.set("X-Barry-Turn-Id", turn.id);
      if (turn.state === "queued" && !req.headers.accept?.includes("text/event-stream")) {
        res.status(202).json({ id: turn.id, state: "queued" });
        return;
      }
      await stream(req, res, req.params.sessionId, { sequence: 0, index: -1 }, authorizationIntervalMs, turn.runId);
    } catch (error) { problem(res, error); }
  });

  routes.route(aguiRoutes.cancelBarryTurn, async (req, res) => {
    try { res.json(await turnExecutionService().execution.cancel(req.params.sessionId, req.params.turnId)); }
    catch (error) { problem(res, error); }
  });
  return router;
}
