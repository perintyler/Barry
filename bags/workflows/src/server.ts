import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hasBrowserSession, carriesSecret, handleSignIn, isAuthorized } from "@barry-rocks/sdk/auth";
import { verifyWorkflowActor } from "@barry-rocks/sdk/internal/auth";
import { dispatchWorkerRequest, WORKER_CREDENTIAL_PREFIX, publicError, WorkflowError, limits, encodeEnvelope, authorizeRun, runRequestSchema, type RunApproval, type RunAuthorization, type WorkflowOwner, type WorkflowRun, type StorageHealth, workSubmissionSchema, workDelegationRecordSchema, type WorkAdmissionService, type WorkDelegationCredentials, type WorkReadService, type WorkControlService, type WorkAdmission, type WorkSubmission, recoveryActivationSchema, workStopSchema, workReconciliationSchema, workListQuerySchema, createRemoteArtifactHttpHandler, extractExecutionBinding, sameExecutionBinding, type WorkArtifactStore } from "@barry-rocks/sdk/internal/workflows";
import type { ToolCallBounds } from "@barry-rocks/sdk/bounds";
import { intersectWorkflowBounds, type ApprovedBounds } from "@barry-rocks/sdk/bounds";

const assets = new Map([ ["/work", ["work.html", "text/html"]], ["/work.js", ["work.js", "text/javascript"]], ["/work.css", ["work.css", "text/css"]], ["/", ["index.html", "text/html"]], ["/app.js", ["app.js", "text/javascript"]], ["/style.css", ["style.css", "text/css"]] ]);
for (const file of ["api.js", "state.js", "routing.js", "operations.js", "waiting-reasons.js"]) assets.set(`/${file}`, [file, "text/javascript"]);
const status = z.enum(["running", "blocked", "completed", "failed", "cancelled", "timed_out"]);
const listSchema = z.object({ status: status.optional(), search: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().nonnegative().default(0) });
const startSchema = z.strictObject({ id: z.string().min(1).max(200), type: z.string().min(1).max(200), version: z.string().min(1).max(200), input: z.json(), timeoutMs: z.number().int().positive().optional(), job: runRequestSchema.optional(), recoveryEpoch: z.uuid().optional() });
const summary = (run: WorkflowRun | null) => run ? { ...run, input: null, outcome: run.outcome?.ok === false ? run.outcome : null } : null;

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new WorkflowError("UnsupportedMediaType", "application/json required", 415);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > limits.envelope) throw new WorkflowError("PayloadTooLarge", "Request body exceeds 1 MiB.", 413);
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  encodeEnvelope(value); // Bound nesting before recursive schema/policy validation.
  return value;
}
function json(response: ServerResponse, body: unknown, code = 200): void {
  if (response.destroyed || response.writableEnded) return;
  if (code >= 400 && body && typeof body === "object" && !("code" in body)) {
    const message = "error" in body && typeof body.error === "string" ? body.error : "Request failed.";
    body = { code: ({ 401: "Unauthorized", 403: "Forbidden", 404: "NotFound" } as Record<number, string>)[code] ?? "InvalidRequest", message, error: message, requestId: randomUUID(), retryable: code >= 500 };
  }
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > limits.envelope) throw new WorkflowError("ResponseTooLarge", "Response exceeds 1 MiB; use summary pages and individual payload details.", 413);
  response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(serialized);
}

export type IdentityGrant = { types: string[]; operations: string[]; payloadRead: boolean };
/**
 * `authenticateWorker` maps a worker credential (`barry_wk_…`) to the worker
 * id the owner invited; null refuses it. A worker credential is good for
 * `/api/worker` and `/api/worker/artifacts/*` and nothing else, and the worker
 * id always comes from it, never from the request body.
 */
export function createWorkflowServer(options: { workStart?: (input: Pick<WorkSubmission, "version" | "request_id" | "idempotency_key" | "definition" | "inputs" | "recovery_epoch">) => Promise<{ work: WorkAdmission; created: boolean }>; workCatalog?: () => unknown; workControls?: WorkControlService<string | null>; workReads?: WorkReadService<string | null>; workerDispatch?: (worker: string, request: unknown) => Promise<unknown>; workAdmission?: WorkAdmissionService<WorkDelegationCredentials>; workArtifacts?: WorkArtifactStore; remoteArtifactHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>; owner: WorkflowOwner; secret: string; authenticateWorker: (credential: string) => string | null; healthy?: () => boolean; draining?: () => boolean; actorKey?: string; readActorKey?: () => Promise<string | undefined>; grants?: () => Record<string, IdentityGrant>; storageHealth?: StorageHealth; clockDiagnostics?: () => unknown; maintenance?: () => unknown; runAuthorization?: RunAuthorization; currentRunScope?: (job: Parameters<RunAuthorization>[0], authorizer: string, delegation?: RunApproval["delegation"]) => Promise<ApprovedBounds> }) {
  if (!options.secret) throw new Error("BARRY_SECRET is required");
  const remoteArtifactHandler = options.remoteArtifactHandler ?? (options.workArtifacts ? createRemoteArtifactHttpHandler({
    artifacts: options.workArtifacts,
    authenticateWorker: options.authenticateWorker,
    authorizeExecution: (workerId, binding, planDigest) => {
      const delegation = options.owner.executionDelegation(workerId, binding.attempt_id);
      const expected = extractExecutionBinding(delegation);
      if (!sameExecutionBinding(binding, expected) || planDigest !== expected.plan_digest) {
        throw new WorkflowError("ExecutorBindingConflict", "Execution binding mismatch.", 409);
      }
      return { delegation };
    },
  }) : undefined);
  const server = createServer({ requestTimeout: 10_000 }, async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(request.url ?? "/", "http://service.invalid");
      if (url.pathname === "/live" && request.method === "GET") return json(response, { ok: true });
      if (["/health", "/ready"].includes(url.pathname) && request.method === "GET") {
        const ok = (options.healthy?.() ?? true) && (options.storageHealth?.ready ?? true) && options.owner.storageAccounted && !options.draining?.() && (url.pathname !== "/ready" || options.owner.recoveryAdmission?.active !== false);
        const state = options.storageHealth && !options.storageHealth.ready ? options.storageHealth.state : options.draining?.() ? "draining" : !options.owner.storageAccounted ? "migrating" : options.owner.recoveryAdmission?.active === false ? "recovery-paused" : ok ? "ready" : "degraded";
        return json(response, { ok, state, admissionPaused: options.owner.recoveryAdmission?.active === false }, ok ? 200 : 503);
      }
      if (url.pathname === "/favicon.ico" && request.method === "GET") { response.writeHead(204); response.end(); return; }
      if (remoteArtifactHandler && (url.pathname === "/api/worker/artifacts/download" || url.pathname === "/api/worker/artifacts/stage")) {
        if (options.storageHealth && !options.storageHealth.ready) throw new WorkflowError("StoreUnavailable", "Owner storage is degraded; preserve the request ID and retry later.", 503, true);
        if (await remoteArtifactHandler(request, response)) return;
      }
      const [scheme, bearer] = (request.headers.authorization ?? "").split(" ");
      if (scheme === "Bearer" && bearer?.startsWith(WORKER_CREDENTIAL_PREFIX)) {
        const worker = options.authenticateWorker(bearer);
        if (!worker || url.pathname !== "/api/worker" || request.method !== "POST") return json(response, { error: "worker credentials are only accepted by POST /api/worker" }, 401);
        const message = z.strictObject({ request: z.unknown() }).parse(await readBody(request));
        if (options.draining?.() && message.request && typeof message.request === "object" && "operation" in message.request && message.request.operation === "claim") return json(response, { error: "Owner is draining", code: "Draining", retryable: true }, 503);
        if (options.storageHealth && !options.storageHealth.ready) throw new WorkflowError("StoreUnavailable", "Owner storage is degraded; preserve the request ID and retry later.", 503, true);
        return json(response, options.workerDispatch ? await options.workerDispatch(worker, message.request) : dispatchWorkerRequest(options.owner, worker, message.request));
      }
      if (url.pathname === "/sign-in") {
        // Barry's shared sign-in page carries its own inline stylesheet.
        response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        if (await handleSignIn(request, response, options.secret, "Workflows")) return;
      }
      if (!isAuthorized(request, options.secret)) {
        if (url.pathname.startsWith("/api/")) return json(response, { error: "Sign in to view workflow runs." }, 401);
        response.writeHead(303, { Location: "/sign-in" }); response.end(); return;
      }
      if (request.method === "POST" && !carriesSecret(request, options.secret)) {
        const origin = request.headers.origin;
        if (!origin || new URL(origin).host !== request.headers.host || request.headers["sec-fetch-site"] === "cross-site") return json(response, { error: "cross-origin write refused" }, 403);
      }
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [file, contentType] = assets.get(url.pathname)!;
        response.writeHead(200, { "Content-Type": `${contentType}; charset=utf-8`, "Cache-Control": "no-store" });
        response.end(readFileSync(new URL(`../web/${file}`, import.meta.url))); return;
      }
      const owner = options.owner;
      if (url.pathname === "/api/metadata" && request.method === "GET") {
        if (request.headers["x-workflow-actor"] !== undefined) return json(response, { error: "not found" }, 404);
        const recovery = owner.recoveryAdmission, catalog = options.workCatalog?.() ?? { enabled: false, definitions: [] };
        const work = recovery?.active === false && catalog !== null && typeof catalog === "object" ? { ...catalog, enabled: false } : catalog;
        return json(response, { version: 2, installation: options.owner.id, limits, profile: "portable", browserPrincipal: "local-operator", recovery, work, clock: options.clockDiagnostics?.(), maintenance: options.maintenance?.() });
      }
      if (request.method === "POST" && options.storageHealth && !options.storageHealth.ready) throw new WorkflowError("StoreUnavailable", "Owner storage is degraded; preserve the request ID and retry later.", 503, true);
      let requestBody: Promise<unknown> | undefined;
      const body = () => requestBody ??= readBody(request);
      if (url.pathname === "/api/v2/work/submissions" && request.method === "POST") {
        if (!options.workAdmission) return json(response, { error: "Work admission is not configured." }, 404);
        if (!carriesSecret(request, options.secret) || request.headers["x-workflow-actor"] !== undefined) throw new WorkflowError("DelegatedServiceRequired", "Work submissions require a service hop and dedicated request-bound delegation.", 403);
        if (options.draining?.()) throw new WorkflowError("Draining", "Owner is draining; preserve the key.", 503, true);
        const submitted = z.strictObject({ request: workSubmissionSchema, delegation: z.strictObject({ assertion: z.string().min(1).max(8192), record: workDelegationRecordSchema }) }).parse(await body());
        const accepted = await options.workAdmission.submitWithReceipt(submitted.request, submitted.delegation);
        return json(response, { work: accepted.work }, accepted.created ? 201 : 200);
      }
      const actorHeader = request.headers["x-workflow-actor"];
      let principal: string | undefined;
      let policyRef: string | undefined;
      let execution: ToolCallBounds | undefined;
      let grantedTypes: string[] = [];
      let grant: IdentityGrant | undefined;
      let auditOperation = request.method ?? "unknown";
      const denied = (message: string, code = 403) => {
        const requestId = randomUUID();
        options.owner.auditDenial(principal, auditOperation, message, url.pathname, requestId);
        return json(response, { code: code === 404 ? "NotFound" : "Forbidden", message, error: message, requestId, retryable: false }, code);
      };
      if (actorHeader !== undefined) {
        if (typeof actorHeader !== "string") return denied("workflow actor unavailable");
        let actorKey: string | undefined;
        try { actorKey = options.readActorKey ? await options.readActorKey() : options.actorKey; }
        catch { return denied("workflow actor unavailable"); }
        if (!actorKey) return denied("workflow actor unavailable");
        let operation: string;
        try { const actor = verifyWorkflowActor(actorHeader, actorKey, `${url.pathname}${url.search}`, request.method === "POST" ? await body() : undefined); principal = actor.principal; operation = actor.operation; auditOperation = operation; policyRef = actor.policyHash; execution = actor.execution; }
        catch { return denied("invalid workflow actor"); }
        grant = options.grants?.()[principal];
        grantedTypes = grant?.types ?? [];
        if (!grantedTypes.length) return denied("workflow identity revoked or not granted");
        if (!grant?.operations.includes(operation)) return denied("workflow operation is not granted");
      }
      if (options.draining?.() && request.method === "POST" && !url.pathname.endsWith("/cancel") && !url.pathname.endsWith("/stop") && url.pathname !== "/api/worker") return json(response, { error: "Owner is draining", code: "Draining", retryable: true }, 503);
      if (url.pathname === "/api/worker") return denied("a worker credential from `barry workers invite` is required");
      if (url.pathname === "/api/v2/recovery" && request.method === "GET" && !url.search) {
        if (principal !== undefined) return denied("recovery administration requires the local operator");
        return json(response, { recovery: owner.recoveryAdmission, activation: owner.recoveryActivation });
      }
      if (url.pathname === "/api/v2/recovery/activate" && request.method === "POST" && !url.search) {
        if (principal !== undefined) return denied("recovery administration requires the local operator");
        return json(response, owner.activateAdmission(recoveryActivationSchema.parse(await body()), "local-operator"));
      }
      if (url.pathname === "/api/v2/work" || url.pathname.startsWith("/api/v2/work/")) {
        if (url.pathname === "/api/v2/work/start" && request.method === "POST" && !url.search) {
          if (principal !== undefined || !hasBrowserSession(request, options.secret)) return denied("operator admission requires a signed-in browser; service hops need dedicated delegation");
          if (!options.workStart) return denied("operator work admission is not configured", 404);
          const input = workSubmissionSchema.pick({ version: true, request_id: true, idempotency_key: true, definition: true, inputs: true, recovery_epoch: true }).parse(await body());
          const accepted = await options.workStart(input);
          return json(response, { work: accepted.work }, accepted.created ? 201 : 200);
        }
        const reconciliation = /^\/api\/v2\/work\/([^/]+)\/reconciliation$/.exec(url.pathname);
        if (reconciliation && !url.search && ["GET", "POST"].includes(request.method ?? "")) {
          if (!options.workControls) return denied("not found", 404);
          if (principal !== undefined) return denied("reconciliation requires the local operator");
          const id = decodeURIComponent(reconciliation[1]);
          return json(response, request.method === "GET" ? await options.workControls.evidence(id, null) :
            await options.workControls.reconcile(id, workReconciliationSchema.parse(await body()), null));
        }
        const stop = /^\/api\/v2\/work\/([^/]+)\/stop$/.exec(url.pathname);
        if (stop && request.method === "POST" && !url.search) {
          if (!options.workControls) return denied("not found", 404);
          if (principal && !grant?.operations.includes("cancel")) return denied("work stop is not granted");
          return json(response, await options.workControls.stop(decodeURIComponent(stop[1]), workStopSchema.parse(await body()), principal ?? null));
        }
        if (!options.workReads || request.method !== "GET") return denied("not found", 404);
        if (principal && !grant?.operations.includes(url.pathname === "/api/v2/work" ? "list" : "get")) return denied("work read is not granted");
        // Scope comes exclusively from the authenticated adapter, never URL fields.
        if (url.pathname === "/api/v2/work") {
          const query = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).optional(), states: z.string().optional(), definition_kind: z.enum(["action", "job", "workflow"]).optional(), definition_ref: z.string().max(200).optional(), trigger: z.enum(["invocation", "schedule", "event", "internal", "manual"]).optional(), after: z.coerce.number().int().nonnegative().optional(), before: z.coerce.number().int().nonnegative().optional(), cursor: z.string().max(2048).optional() }).parse(Object.fromEntries(url.searchParams));
          return json(response, await options.workReads.list({ ...query, states: workListQuerySchema.shape.states.parse(query.states?.split(",")) }, principal ?? null));
        }
        if (url.pathname === "/api/v2/work/operations") {
          const query = z.strictObject({ key: z.string().min(1).max(200), session: z.string().min(1).max(200).optional() }).parse(Object.fromEntries(url.searchParams));
          return json(response, await options.workReads.lookupOperation(query.key, principal ?? null, query.session));
        }
        const result = /^\/api\/v2\/work\/([^/]+)\/result$/.exec(url.pathname);
        if (result && !url.search) {
          if (principal && !grant?.payloadRead) return denied("work output read is not granted");
          return json(response, await options.workReads.result(decodeURIComponent(result[1]), principal ?? null));
        }
        const detail = /^\/api\/v2\/work\/([^/]+)$/.exec(url.pathname);
        if (detail && !url.search) return json(response, await options.workReads.inspect(decodeURIComponent(detail[1]), principal ?? null));
        return denied("not found", 404);
      }
      if (url.pathname === "/api/overview" && request.method === "GET") return json(response, owner.overview(principal));
      if (url.pathname === "/api/audit" && request.method === "GET") { if (principal) return denied("not found", 404); return json(response, owner.policyDenials(url.searchParams.get("after") ?? "")); }
      if (url.pathname.startsWith("/api/workers/") && request.method === "GET") {
        if (principal) return json(response, { error: "not found" }, 404);
        return json(response, owner.workerDetails(decodeURIComponent(url.pathname.slice("/api/workers/".length))));
      }
      if (url.pathname === "/api/v2/runs" && request.method === "GET") {
        const filters = z.object({ status: status.optional(), prefix: z.string().max(200).optional(), type: z.string().max(200).optional(), identity: z.string().min(1).max(200).optional(), creator: z.string().min(1).max(200).optional(), worker: z.string().min(1).max(200).optional(), blockingReason: z.enum(["PolicyRevoked", "OutcomeUnknown", "SessionBusy", "ReconciliationRequired", "RequiredContainmentUnavailable"]).optional(), profile: z.enum(["portable", "resource-contained"]).optional(), startedAfter: z.coerce.number().int().nonnegative().optional(), startedBefore: z.coerce.number().int().nonnegative().optional(), cursor: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(Object.fromEntries(url.searchParams));
        return json(response, owner.listPage({ ...filters, principal }));
      }
      if (url.pathname === "/api/runs") {
        if (request.method === "GET") return json(response, owner.list({ ...listSchema.parse(Object.fromEntries(url.searchParams)), metadataOnly: true, principal }));
        if (request.method === "POST") {
          const input = startSchema.parse(await body());
          if (principal && !grantedTypes.includes(input.type)) return denied("workflow type is not granted");
          if (input.job && !options.runAuthorization) throw new WorkflowError("JobAuthorizationUnavailable", "Run permission resolution is unavailable.", 503, true);
          const approved = input.job ? await authorizeRun(input.job, principal ?? "local-operator", options.runAuthorization!, Date.now(), execution) : undefined;
          return json(response, summary(owner.start(input, principal, policyRef, approved)), owner.asynchronous ? 202 : 201);
        }
      }
      const match = /^\/api\/runs\/([^/]+)(?:\/(history|signal|cancel|resume|reauthorize|permissions|resources|payloads|command|receipt|eligibility))?$/.exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]), action = match[2];
        if (principal) {
          const run = owner.get(id);
          if (run.principal !== principal || (request.method === "POST" && !grantedTypes.includes(run.type))) return denied("not found", 404);
        }
        if (principal && (action === "payloads" || action === "command") && !grant?.payloadRead) return denied("payload.read is not granted");
        if (request.method === "GET" && !action) return json(response, owner.inspect(id, { metadataOnly: true, after: url.searchParams.get("after") ?? undefined }));
        if (request.method === "GET" && action === "history") return json(response, url.searchParams.has("page") ? owner.historyPage(id, { after: Number(url.searchParams.get("after") ?? 0), type: url.searchParams.get("type") ?? undefined }) : owner.history(id, Number(url.searchParams.get("after") ?? 0), 100, true));
        if (request.method === "GET" && action === "payloads") return json(response, { input: owner.get(id).input, outcome: owner.get(id).outcome });
        if (request.method === "GET" && action === "command") return json(response, owner.commandDetails(id, url.searchParams.get("id") ?? "", Number(url.searchParams.get("after") ?? 0)));
        if (request.method === "GET" && action === "receipt") return json(response, summary(owner.receipt(id, url.searchParams.get("id") ?? "")));
        if (request.method === "GET" && action === "eligibility") return json(response, owner.eligibility(id, Number(url.searchParams.get("after") ?? -1), !principal));
        if (request.method === "GET" && action === "permissions") {
          const approved = owner.grant(id);
          if (!approved || !options.currentRunScope) return json(response, { grant: approved ?? null, currentPolicyAvailable: false, observedAt: Date.now() });
          try {
            const current = await options.currentRunScope(approved.job, approved.authorizer, approved.delegation);
            const context: ToolCallBounds = { identity: current.identity, ...(current.bags !== undefined ? { bags: current.bags } : {}), ...(current.bounds !== undefined ? { bounds: current.bounds } : {}), bound: current.bound, harness: current.harness, allowedToolIds: Object.keys(current.tools) };
            const currentTools = Object.entries(current.tools).map(([id, access]) => { const split = id.indexOf(":"); return { namespace: id.slice(0, split), toolName: id.slice(split + 1), access, contractHash: current.contracts?.[id] }; });
            const effective = intersectWorkflowBounds(approved.scope, context, currentTools);
            return json(response, { grant: approved, currentPolicyAvailable: true, effective, observedAt: Date.now(), policyView: "identity-and-selected-bags; destination and live-attempt checks still required" });
          } catch {
            return json(response, { grant: approved, currentPolicyAvailable: false, reason: "Current policy could not be resolved; privileged execution must fail closed.", observedAt: Date.now() });
          }
        }
        if (request.method === "GET" && action === "resources") {
          const resources = owner.resources(id);
          return json(response, { ...resources, input: principal && !grant?.payloadRead ? null : resources.input });
        }
        if (request.method === "POST") {
          const value = await body();
          if (action === "reauthorize") {
            const input = z.strictObject({ requestId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(), job: runRequestSchema, reason: z.string().min(1).max(1000) }).parse(value);
            if (!options.runAuthorization) throw new WorkflowError("JobAuthorizationUnavailable", "Run permission resolution is unavailable.", 503, true);
            const previous = owner.grant(id);
            if (!previous) throw new WorkflowError("GrantRequired", "Legacy runs cannot implicitly acquire privileged execution.", 409);
            const approved = await authorizeRun(input.job, principal ?? "local-operator", options.runAuthorization, Date.now(), execution);
            return json(response, summary(owner.reauthorize(id, { ...approved, createdBy: previous.createdBy, revision: previous.revision + 1, reason: input.reason }, input.requestId, input.expectedRevision, principal ?? "local-operator")));
          }
          if (action === "signal") {
            const signal = z.strictObject({ signalId: z.string(), name: z.string(), payload: z.json() }).parse(value);
            return json(response, summary(owner.signal(id, signal.signalId, signal.name, signal.payload, principal)));
          }
          const mutation = z.strictObject({ requestId: z.string().optional(), expectedRevision: z.number().int().nonnegative().optional() }).parse(value);
          if ((action === "cancel" || action === "resume") && mutation.requestId && mutation.expectedRevision !== undefined) return json(response, summary(owner.mutate(id, action, mutation.requestId, mutation.expectedRevision, principal)));
          if (action === "cancel") return json(response, summary(owner.cancel(id, principal)));
          if (action === "resume") return json(response, summary(owner.resume(id, principal)));
        }
      }
      json(response, { error: "not found" }, 404);
    } catch (error) {
      options.storageHealth?.observe(error);
      const result = publicError(error);
      if (result.body.retryable) response.setHeader("Retry-After", "1");
      json(response, result.body, result.status);
    }
  });
  server.maxConnections = 128;
  server.headersTimeout = 10_000;
  return server;
}
