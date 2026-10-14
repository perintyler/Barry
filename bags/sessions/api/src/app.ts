import { createLogger } from "@barry-rocks/sdk/logging";
import { sessionIdentity } from "@barry-rocks/sdk/stores";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { hasValidSecret } from "@barry-rocks/sdk/internal/auth";

import express from "express";
import { requestSessionId, sessionRequestAuthorization } from "./request-authorization.js";
import { sessionsRouter } from "./routes/sessions.js";
import { statusRouter } from "./routes/status.js";
import { transcriptRouter } from "./routes/transcript.js";

import { eventsRouter } from "@barry-rocks/events-bag";
import { applyAuth, applyBaseMiddleware, createErrorLogger, createRequestLogger, servedRoutes } from "@barry-rocks/sdk/services/http";
import { changesRouter } from "./routes/changes.js";
import { modelsRouter } from "./routes/models.js";
import { sessionChangesRouter } from "./routes/session-changes.js";
import { sessionLifecycleRouter } from "./routes/session-lifecycle.js";
import { sessionViewRouter } from "./routes/session-view.js";
import { webhooksRouter } from "./routes/webhooks.js";
// Same seam, generalized beyond events: any topic, any process. The events bag
// keeps its own because its announce path is already a published contract.
import { publishToTopic } from "./bus-registry.js";
import { createDelivery } from "./delivery.js";
import { actionsRouter } from "./routes/actions.js";
import { createAgUiRouter } from "./routes/ag-ui.js";
import { jobsRouter } from "./routes/jobs.js";
import { otlpRouter } from "./routes/otlp.js";
import { promptsRouter } from "./routes/prompts.js";
import { schedulesRouter } from "./routes/schedules.js";
import { sessionRuntime } from "./session-runtime.js";

import openapi from "@barry-rocks/sdk/openapi.json" with { type: "json" };

import type { DeliveryHost } from "./delivery.js";
import { apiContractMiddleware } from "./http.js";
import { withTimeout } from "./with-timeout.js";

export function sessionsApi(delivery: DeliveryHost = createDelivery()) {
  const app = express();
  const apiV1 = express.Router();
  const log = createLogger("barry-server");
  // Large-body parsers run before the base 1mb parser so their routes can read
  // bodies over 1mb (OTLP batches; base64 attachments). To keep an
  // unauthenticated loopback process from making the API parse up to 10mb/30mb
  // before it is ever rejected (SES-18), each large parser is gated on a valid
  // instance secret: without it, the request skips the big parser, falls through
  // to the 1mb base parser, and is answered 401/403 by `applyAuth`. The OTLP and
  // attachment routes are installation-only, so a device principal legitimately
  // skips here and is refused by the route's own authorization.
  const otlpParser = express.json({ limit: "10mb" });
  const attachmentParser = express.json({ limit: "30mb" });
  const attachmentUpload = /^\/api\/v1\/sessions\/[^/]+\/attachments\/?$/;
  app.use((req, res, next) => {
    if (!hasValidSecret(req)) return next();
    if (req.path.startsWith("/v1/")) return otlpParser(req, res, next);
    if (req.method === "POST" && attachmentUpload.test(req.path)) return attachmentParser(req, res, next);
    next();
  });
  // Security headers, body parsing, rate limiting and CORS — shared with the
  // identities service so the two cannot drift apart on defaults that are
  // really security posture.
  applyBaseMiddleware(app);
  app.use(createRequestLogger("barry-server", {
    skip: (req) => req.path === "/health",
  }));

  // Health check (no auth) — includes enough detail for local diagnostics
  const serverStartTime = Date.now();

  /** Bound health dependency waits below the probe timeout; timeout reports degraded connectivity without cancelling work. */
  const HEALTH_DB_TIMEOUT_MS = 1500;

  /** Liveness performs no I/O so dependency stalls cannot block the process probe. */
  app.get("/health/live", (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      ok: true,
      service: "barry-server",
      uptime: Math.floor((Date.now() - serverStartTime) / 1000),
      activeSessions: sessionRuntime.getActiveSessionCount(),
      memoryUsage: { rss: mem.rss },
    });
  });

  /**
   * Readiness: liveness plus the dependencies needed to serve real traffic.
   *
   * Answers **503 with `ok: false`** when the session store is unreachable, and
   * 200 otherwise. This is the readiness contract: a lost store means the
   * service cannot serve real traffic, so the supervisor should restart it
   * rather than leave it reporting healthy forever (the complaint in SES-11).
   *
   * The reason this status code was safe to change here, and only here: the
   * supervisor probes *every* service's declared `/health`, and callers treat a
   * non-2xx as "down". Flipping `/health` to a real readiness code without a
   * pure-liveness probe would conflate "the process is alive" with "the store is
   * reachable". This service has `/health/live` (I/O-free) for the former, so
   * `/health` is free to mean readiness. Callers that only want liveness point
   * at `/health/live`.
   *
   * The healthy path keeps `ok: true` and 200 so the services bag's health-check
   * job (which greps for `"ok":true`) and the metrics collector (which reads
   * `res.ok`) still read a reachable store as up; only a genuinely unreachable
   * store now reads as down.
   */
  app.get("/health", async (_req, res) => {
    // Probe the session store through its client seam, independent of backend.
    // See docs/decisions/0035-session-route-and-summary-rationale.md.
    const { getSessionStats } = await import("@barry-rocks/sessions-bag/client");

    const probe = await withTimeout(getSessionStats(), HEALTH_DB_TIMEOUT_MS);
    const dbConnected = probe !== null;

    // Diagnostic only, and skipped entirely when the store is already known to
    // be unreachable — no point spending a second timeout to learn it twice.
    let lastSessionCompleted: string | null = null;
    if (dbConnected) {
      // `listSessions` returns records directly and has no `state` filter; the
      // inactive ones are the completed ones, and the first with a
      // `completed_at` is the most recent because the store orders by activity.
      const { listSessions } = await import("@barry-rocks/sessions-bag/client");
      const recent = await withTimeout(listSessions({ limit: 20, active: false }), HEALTH_DB_TIMEOUT_MS);
      const first = recent?.find((r) => r.completed_at != null);
      if (first?.completed_at) {
        // Already an ISO string on the wire — the seam normalises it.
        lastSessionCompleted = String(first.completed_at);
      }
    }

    const mem = process.memoryUsage();
    // Liveness is covered by /health/live; readiness fails closed when the
    // store the service needs to serve traffic cannot be reached.
    res.status(dbConnected ? 200 : 503).json({
      ok: dbConnected,
      service: "barry-server",
      uptime: Math.floor((Date.now() - serverStartTime) / 1000),
      activeSessions: sessionRuntime.getActiveSessionCount(),
      dbConnected,
      lastSessionCompleted,
      memoryUsage: { rss: mem.rss },
    });
  });

  // Home page route (before auth for public access)
  app.get('/', (req, res) => {
    res.json({
      message: 'Welcome to Barry',
      navigation: {
        sessions: '/api/v1/sessions',
        life: '/life'
      }
    });
  });

  // Webhook routes (before auth — signature-verified)
  app.use("/webhooks", webhooksRouter);

  // Auth and the CSRF content-type guard. Everything registered above stays
  // public: /health, /health/live, / and the signature-verified /webhooks.
  applyAuth(app, sessionRequestAuthorization());
  // The authenticated API owns session-scoped bag writes as well as sessions.
  app.use((req, _res, next) => {
    const sessionId = requestSessionId(req);
    const identity = sessionId === undefined ? undefined : sessionIdentity(sessionId);
    return withStoreContext({ identity }, () => next());
  });

  // API routes
  // The action executor is mounted BEFORE apiContractMiddleware on purpose: its
  // wire contract is snake_case (timeout_s in; run_id/output_type out) because it
  // mirrors the action-runs MCP tool surface that run_action proxies verbatim —
  // the middleware would 400 the request key and camelCase the response.
  apiV1.use("/actions", actionsRouter);
  // Same reason twice over: a schedule run answers with the executor's
  // snake_case body, and a one-off's `inputs` are the caller's own values,
  // which the middleware would camelCase.
  apiV1.use("/schedules", schedulesRouter);
  // A job run is a one-off, with the same camelCase-but-verbatim-inputs contract.
  apiV1.use("/jobs", jobsRouter);
  // Delivery (see ./delivery.ts): its client reads these bodies verbatim, and a
  // guarantees map keyed by session id must not be camelCased.
  const prompts = promptsRouter(delivery);
  apiV1.use("/prompts", prompts);
  apiV1.use(apiContractMiddleware);
  apiV1.get("/openapi.json", (_req, res) => res.json(openapi));
  apiV1.use("/sessions", sessionsRouter);
  apiV1.use("/sessions", transcriptRouter);
  apiV1.use("/status", statusRouter);
  apiV1.use("/changes", changesRouter);
  apiV1.use("/sessions", sessionLifecycleRouter);
  apiV1.use("/sessions", sessionChangesRouter);
  apiV1.use("/sessions", sessionViewRouter);
  apiV1.use("/models", modelsRouter);
  // Mount only the API namespaces implemented by this service.
  // See docs/decisions/0037-service-route-and-tool-identity-rationale.md.
  apiV1.use("/events", eventsRouter);

  /**
   * POST /identities/announce — put an identity change on the bus from elsewhere.
   *
   * `queued` counts accepted publications; subsequent authorization or transport
   * failure can prevent receipt, so it must not imply client delivery.
   */
  apiV1.post("/identities/announce", (req, res) => {
    const { id, kind } = (req.body ?? {}) as { id?: unknown; kind?: unknown };
    if (typeof id !== "string" || !id || typeof kind !== "string" || !kind) {
      return res.status(400).json({ ok: false, error: "id and kind are required" });
    }
    const queued = publishToTopic("identities", { type: "bus", topic: "identities", id, kind });
    res.json({ ok: true, queued });
  });

  apiV1.use((req, res) => {
    res.status(404).type("application/problem+json").json({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "No API operation matches this request",
      instance: req.originalUrl,
    });
  });
  app.use("/api/v1", apiV1);
  const agUi = createAgUiRouter();
  app.use("/api/v2/sessions", agUi);
  // The OTLP receiver, at the vendor's paths under this API's root (see
  // ./routes/otlp.ts).
  app.use("/v1", otlpRouter);

  app.use(createErrorLogger("barry-server"));
  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    res.status(500).type("application/problem+json").json({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      detail: "The server could not complete the request",
      instance: req.originalUrl,
    });
    log.error("request.unhandled", { error: error instanceof Error ? error.message : String(error) });
  });


  return { app, routes: [actionsRouter, schedulesRouter, jobsRouter, prompts, sessionsRouter, transcriptRouter, statusRouter, changesRouter, sessionLifecycleRouter, sessionChangesRouter, sessionViewRouter, modelsRouter, eventsRouter, agUi].flatMap(router => servedRoutes(router)) };
}
