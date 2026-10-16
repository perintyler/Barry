import { PersistenceBacklogError } from "../runtime/persist-queue.js";
// Send-message route for the sessions lifecycle router.
// Extracted verbatim from session-lifecycle.ts for file size; no behavior change.
import { messageTimingHeader } from "../runtime/timing.js";
import { Barry, requestCaller, type Bound } from "@barry-rocks/sdk";
import { createLogger } from "@barry-rocks/sdk/logging";
import { sessionsRoutes } from "@barry-rocks/sdk/internal/routes";
import type { serve } from "@barry-rocks/sdk/services/http";
import { classify as classifyProcessLiveness } from "@barry-rocks/sessions-bag/process-liveness";
import { parseMetadata as parseSessionMetadata } from "@barry-rocks/sessions-bag/store/session-helpers";
import { Processes, claimFailedPromptRetry, getListeners, getMessageByClientMessageId, queuePrompt, recordPromptDelivery, updatePromptDeliveryByClientMessageId, type PromptDeliveryState } from "@barry-rocks/sessions-bag/client";
import { reportDelivery } from "@barry-rocks/sessions-bag/delivery";
import { buildSessionHistoryContext, getSessionRecord } from "../db.js";
import { AdmissionError } from "../execution-admission.js";
import { parseRequestBody } from "../http.js";
import { sessionMcpServers } from "../mcp-config.js";
import { validateRepoPath } from "../repo-paths.js";
import { sessionRuntime } from "../session-runtime.js";

const log = createLogger("barry-server");

function classifyDeliveryFailure(error: unknown): PromptDeliveryState {
  if (error instanceof AdmissionError) return "failed";
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (text.includes("not found") || text.includes("invalid") || text.includes("forbidden")) {
    return "failed";
  }
  return "uncertain";
}

export function registerSendMessageRoute(routes: ReturnType<typeof serve>): void {
routes.route(sessionsRoutes.sendMessage, async (req, res) => {
    const ingressAt = performance.now();
  if (process.env.BARRY_DISABLE_APP_PROTOCOL_V1 === "true") {
    return res.status(410).json({
      ok: false,
      error: "App Protocol v1 message endpoint is disabled. Use /api/v2/sessions/:id/ag-ui instead.",
    });
  }
  let requestContent: string | null = null;
  let requestClientMessageId: string | undefined;
  let retryingFailedPrompt = false;
  let userMessageSequence: number | undefined;
  try {
    const input = parseRequestBody(req, res, sessionsRoutes.sendMessage.body);
    if (!input) return;
    const { content, repoPath: rawRepoPath, clientMessageId } = input;
    requestContent = content;
    requestClientMessageId = clientMessageId;
    const sessionId = req.params.sessionId;

    const previousAccepted=sessionRuntime.getActiveSession(sessionId)?.acceptedMessages;
    if (clientMessageId && previousAccepted?.has(clientMessageId)) {
      if (previousAccepted.get(clientMessageId)!==content) return res.status(409).json({ok:false,error:"clientMessageId belongs to different content"});
      return res.status(202).json({ok:true,sessionId,status:"idempotent-retry",deliveryState:"accepted",clientMessageId});
    }
    sessionRuntime.assertPersistenceAdmission(sessionId);
    const ps = await getSessionRecord(sessionId);
    if (!ps) {
      return res.status(404).json({ ok: false, error: "Session not found" });
    }

    if (clientMessageId) {
      const existing = await getMessageByClientMessageId(sessionId, clientMessageId);
      if (existing) {
        if (existing.content !== undefined && existing.content !== content) {
          return res.status(409).json({ ok: false, error: "clientMessageId belongs to different content" });
        }
        if (existing.state === "failed") {
          retryingFailedPrompt = !!(await claimFailedPromptRetry(sessionId, clientMessageId, content));
          if (retryingFailedPrompt) {
            userMessageSequence=existing.sequence;
            sessionRuntime.publishDeliveryUpdate(sessionId, {
              messageId: existing.id, clientMessageId, deliveryState: "uncertain",
            });
          }
        }
        if (!retryingFailedPrompt) {
          return res.json({
            ok: true,
            message: "Message already admitted",
            sessionId,
            status: "idempotent-retry",
            deliveryState: (await getMessageByClientMessageId(sessionId, clientMessageId))?.state ?? existing.state,
            messageId: existing.id,
            clientMessageId,
          });
        }
      }
    }

    let activePs = sessionRuntime.getActiveSession(sessionId);
    const wasWarm = activePs?.session?.isWarm?.() === true;

    if (!activePs) {
      // Not active IN THIS PROCESS, but that only covers sessions this API
      // server spawned itself — a session driven by a live `barry start` CLI
      // process is never in that map. Starting one anyway resumes the same
      // transcript a second time, which the underlying agent SDK/CLI rejects
      // (its own resume lock) — the exact "can't have the same session open
      // twice" failure this check exists to avoid. classifyProcessLiveness
      // proves liveness via PID + start-time, the same primitive the stale-
      // session reconciler already trusts (session-runtime.ts) — only a genuine
      // "alive" verdict takes this branch; "dead" and "unknown" fall through
      // to starting fresh below, since guessing a live session is the wrong
      // failure mode (per that reconciler's own established rule).
      const liveProcess = await Processes.getLive(sessionId);
      const identity = liveProcess
        ? { pid: liveProcess.pid, pid_started_at: liveProcess.pidStartedAt, hostname: liveProcess.hostname }
        : parseSessionMetadata(ps.metadata);
      const liveness = classifyProcessLiveness(identity);
      // A newly created draft can carry the API's pid before its first agent
      // starts. Only a running session can have an external driver to receive
      // a queued message; otherwise this first prompt would sit forever.
      if (ps.status === "running" && liveness.state === "alive") {
        // Owned elsewhere. Queue the message as a normal persisted row —
        // it shows up immediately to any reader of GET /:id/messages — and
        // let the live session pick it up on its next tool call (see
        // bag-proxy.ts's CallToolRequestSchema handler) rather than racing
        // a second driver onto the same transcript.
        const queued = retryingFailedPrompt && clientMessageId
          ? await updatePromptDeliveryByClientMessageId(sessionId, clientMessageId, "queued", { status: "pending", source: "web_prompt" })
          : await queuePrompt(sessionId, content, { clientMessageId });
        if (!queued) throw new Error("Message retry row disappeared");
        // Registered listeners determine whether delivery wakes the driver now
        // or waits for its next Barry tool call.
        // See docs/decisions/0035-session-route-and-summary-rationale.md.
        const listeners = await getListeners([sessionId]);
        const report = reportDelivery({
          listenerGuarantee: listeners[sessionId]?.guarantee ?? "none",
          active: true,
        });
        return res.json({
          ok: true,
          message: `Session is active elsewhere; ${report.explanation}`,
          sessionId,
          status: "active-elsewhere",
          delivery: report.delivery,
          deliveryState: queued.state,
          messageId: queued.id,
          clientMessageId: clientMessageId ?? null,
          duplicate: retryingFailedPrompt || ("duplicate" in queued && queued.duplicate),
        });
      }

      // Session not active - need to start it
      // Get repo path from DB or request
      const workDir = rawRepoPath || ps.metadata?.working_directory;

      if (!workDir) {
        return res.status(400).json({
          ok: false,
          error: "Session has no working directory. Set repoPath in request body or update session first.",
        });
      }

      const validated = validateRepoPath(workDir);
      if (!validated.ok) {
        return res.status(400).json({ ok: false, error: validated.error });
      }
      const repoPath = validated.path;

      const bagNames = ps.bags ?? [];
      let tools: Awaited<ReturnType<typeof Barry.tools>> = [];
      try {
        tools = await Barry.as(requestCaller(req.authPrincipal)).tools(
          ps.identity_id ?? null,
          bagNames,
          (ps.bound as Bound | null) ?? ps.bounds ?? [],
        );
      } catch {
        tools = [];
      }
      const mcpServers = await sessionMcpServers(sessionId, tools);

      // Snapshot history before the idempotency row exists. It must not become
      // part of the transcript prepended to this same prompt.
      const initialHistoryContext = await buildSessionHistoryContext(sessionId);
      if (clientMessageId && !retryingFailedPrompt) {
        const recorded = await recordPromptDelivery(sessionId, content, { clientMessageId, delivery: "uncertain" });
        userMessageSequence=recorded.sequence;
        if (recorded.duplicate) {
          return res.json({ ok: true, sessionId, status: "idempotent-retry", deliveryState: recorded.state, messageId: recorded.id, clientMessageId });
        }
      }

      // Start the session via SDK (fall back to provider/model stored on the draft)
      activePs = await sessionRuntime.startSession({
        sessionId,
        prompt: content,
        ingressAt,
        repoPath,
        bags: bagNames,
        bounds: ps.bounds ?? [],
        bound: (ps.bound as Bound | null) ?? null,
        mcpServers,
        useWorktree: !!(ps.metadata?.use_worktree),
        provider: (ps.metadata?.provider as string) || undefined,
        model: (ps.metadata?.model as string) || undefined,
        modelProvider: (ps.metadata?.model_provider as string) || undefined,
        clientMessageId,
        reuseClientMessageRow: !!clientMessageId,
        ...(userMessageSequence!==undefined ? {userMessageSequence} : {}),
        ...(initialHistoryContext!==undefined ? {initialHistoryContext} : {}),
      }, req.authPrincipal);

      if (clientMessageId) {
        const accepted = await updatePromptDeliveryByClientMessageId(sessionId, clientMessageId, "accepted");
        if (!accepted) throw new Error("Message retry row disappeared");
        sessionRuntime.publishDeliveryUpdate(sessionId, { messageId: accepted.id, clientMessageId, deliveryState: "accepted" });
      }

      res.setHeader("X-Barry-Timing", messageTimingHeader({ ingress_ms: performance.now() - ingressAt, admit_ms: performance.now() - ingressAt }, wasWarm));
      res.status(202).json({
        ok: true,
        turn: "queued",
        warm: wasWarm ? 1 : 0,
        message: "Session started with message",
        sessionId: activePs.id,
        status: activePs.status,
        deliveryState: "accepted",
        clientMessageId: clientMessageId ?? null,
      });
    } else {
      // Deduplicate before scheduling a row: a retry may arrive while SQLite is
      // still recording the accepted turn. Reserve the key before any await.
      const accepted = activePs.acceptedMessages ??= new Map();
      if (clientMessageId && accepted.has(clientMessageId)) {
        if (accepted.get(clientMessageId) !== content) return res.status(409).json({ ok: false, error: "clientMessageId belongs to different content" });
        return res.status(202).json({ ok: true, sessionId, status: "idempotent-retry", deliveryState: "accepted", clientMessageId });
      }
      if (clientMessageId) accepted.set(clientMessageId, content);
      try {
        await sessionRuntime.sendMessage(sessionId, content, { ingressAt, clientMessageId, reuseClientMessageRow: retryingFailedPrompt, ...(userMessageSequence!==undefined ? {userMessageSequence} : {}) }, req.authPrincipal);
      } catch (error) { if (clientMessageId) accepted.delete(clientMessageId); throw error; }
      if (retryingFailedPrompt && clientMessageId) await updatePromptDeliveryByClientMessageId(sessionId, clientMessageId, "accepted");

      res.setHeader("X-Barry-Timing", messageTimingHeader({ ingress_ms: performance.now() - ingressAt, admit_ms: performance.now() - ingressAt }, wasWarm));
      res.status(202).json({
        ok: true,
        turn: "queued",
        warm: wasWarm ? 1 : 0,
        message: "Message sent to active session",
        sessionId,
        status: activePs.status,
        deliveryState: "accepted",
        clientMessageId: clientMessageId ?? null,
      });
    }
  } catch (err) {
    if (err instanceof PersistenceBacklogError) {
      const active=sessionRuntime.getActiveSession(req.params.sessionId);
      if(active) sessionRuntime.sendInTurn(active, { type: "error", sessionId: req.params.sessionId,
        error: err.message, metadata: { code: err.code, retryable: true } });
      return res.status(503).json({ ok: false, error: err.message, code: err.code, retryable: true });
    }
    log.error("sessions.message_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });

    if (requestClientMessageId && requestContent) {
      const failureState = classifyDeliveryFailure(err);
      const detail = err instanceof Error ? err.message : String(err);
      const existing = await getMessageByClientMessageId(req.params.sessionId, requestClientMessageId);
      if (existing?.state === "accepted") {
        sessionRuntime.publishDeliveryUpdate(req.params.sessionId, {
          messageId: existing.id,
          clientMessageId: requestClientMessageId,
          deliveryState: "accepted",
          deliveryError: null,
        });
        return res.json({
          ok: true,
          message: "Message was already admitted",
          sessionId: req.params.sessionId,
          status: "idempotent-retry",
          deliveryState: "accepted",
          messageId: existing.id,
          clientMessageId: requestClientMessageId,
        });
      }
      const updated = existing
        ? await updatePromptDeliveryByClientMessageId(
            req.params.sessionId,
            requestClientMessageId,
            failureState,
            { error: detail },
          )
        : null;
      const admitted =
        updated ??
        await recordPromptDelivery(req.params.sessionId, requestContent, {
          ...(sessionRuntime.getActiveSession(req.params.sessionId)?{sequence:sessionRuntime.allocateSequence(req.params.sessionId)}:{}),
          clientMessageId: requestClientMessageId,
          delivery: failureState,
          source: "api_message",
          error: detail,
        });

      sessionRuntime.publishDeliveryUpdate(req.params.sessionId, {
        messageId: admitted.id,
        clientMessageId: requestClientMessageId,
        deliveryState: failureState,
        deliveryError: detail,
      });

      if (failureState === "failed") {
        res.setHeader("Retry-After", "5");
      }

      return res.json({
        ok: true,
        message:
          failureState === "failed"
            ? "Message failed before provider admission"
            : "Message delivery is uncertain; check message history before sending again",
        sessionId: req.params.sessionId,
        status: failureState === "failed" ? "delivery-failed" : "delivery-uncertain",
        deliveryState: failureState,
        messageId: admitted.id,
        clientMessageId: requestClientMessageId,
      });
    }

    if (err instanceof AdmissionError) {
      res.setHeader("Retry-After", "5");
      return res.status(503).json({ ok: false, error: err.message, code:err.code,retryable:true });
    }
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "Failed to send message" });
  }
});
}
