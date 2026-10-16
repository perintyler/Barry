import { Barry } from "@barry-rocks/sdk";
import { servicesRouter } from "./services/routes.js";
import { loadModelVendors, createModels, installModels, installedModels, mergeVendorFactories, assembleVendors, registeredVendorRows } from "@barry-rocks/sdk/adapters/models";
import { barryModelVendorsPath, validateEnv, assignedPort, listenOnAssignedPort, LOOPBACK, barryAdaptersPath } from "@barry-rocks/sdk/services";
import { expandComposition, type BagRegistrySnapshot } from "@barry-rocks/sdk/bags";
import { applyToolVisibility } from "@barry-rocks/sdk/internal/tools";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { type StoreContext, sessionIdentity } from "@barry-rocks/sdk/stores";
import { installStoreContext, withStoreContext } from "@barry-rocks/sdk/internal/stores";

import { installationWorkflowActor } from "./workflow-actor.js";
import {
  verifyWorkflowSessionCredential,
  verifyWorkflowSessionCredentialForSession,
  type WorkflowSessionCredential,
  type WorkflowActorContext,
  authorizeRequest,
  requestCredential,
} from "@barry-rocks/sdk/internal/auth";
import { TransportAuthorization } from "./transport-authorization.js";
import { WorkflowAuthorization } from "./workflow-authorization.js";
import { qualifyToolId, type Bound } from "@barry-rocks/sdk/bounds";
import { registerTsSpecifierHook } from "./ts-specifier-hook.js";
import { randomUUID } from "node:crypto";
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createEditArbiter } from "./edit-arbiter.js";
import {
  createReadinessGate,
  gateMiddleware,
  type ReadinessGate,
} from "./readiness.js";
import type { Server as HttpServer } from "node:http";
import { wrapReadTracking } from "./read-tracking.js";
import { sweepSessionState } from "./session-state.js";
import { createLogger } from "@barry-rocks/sdk/logging";

import { access, identityRecords, type IdentityRecord } from "@barry-rocks/identities-bag";
import {
  createRequestLogger,
} from "@barry-rocks/sdk/services/http";
import { getSession } from "@barry-rocks/sessions-bag/client";
import {
  init as initFileTracker,
  closeDb as closeFileTracker,
} from "@barry-rocks/tracker-bag";
import { loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";

import { installRemoteBagLoader } from "@barry-rocks/sdk/internal/mcp";
import { identityEnvironmentForId as buildIdentityEnvironmentShared, setIdentityStore } from "@barry-rocks/sdk/internal/env";

import {
  BagConnectionPool,
  type FilterableProxiedTool,
} from "./bag-proxy.js";
import {
  loadBagTools,
  loadBagPool,
  buildBagAuthTool,
  buildCredentialStatusTool,
  type BagResourceRegistrar,
  type LoadedToolset,
} from "./bag-loading.js";
import { createSessionToolsResolver } from "./session-tools-resolver.js";
import { registerControlRoutes } from "./control-routes.js";
import { createTransportRefresh } from "./transport-refresh.js";
import { pickEnv, createRateLimiter } from "./http-helpers.js";

import {
  createToolServer,
  createToolServerHandle,
  type ToolServerHandle,
  toToolMeta,
  findDuplicateToolNames,
  wrapEditRecording,
  wrapEditIntent,
  wrapShellEditGuard,
  wrapSecretInjection,
  resolveToolDiscovery,
  type RuntimeTool,
} from "./tool-runtime.js";
import { sessionBound, ANONYMOUS_SESSION_ID } from "./session-bound.js";

import { transportsWithDeadOwners } from "./dead-sessions.js";
import {
  slotKey,
  findSupersededTransport,
  admitTransport as admitTransportDecision,
  attributeTransports,
  PendingAdmissions,
} from "./transport-slots.js";
import { ConnectionLeases } from "./connection-leases.js";

import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";

export interface McpApplicationOptions {
  /** Identity whose declared bindings authorize standalone stdio credentials. */
  identityId?: number;
  harness?: string;
  mode?: "http" | "stdio";
  port?: number;
  snapshot?: BagRegistrySnapshot;
  signal?: AbortSignal;
}
export async function startMcpApplication(
  options: McpApplicationOptions = {},
): Promise<{ close(): Promise<void> }> {
  options.signal?.throwIfAborted();
  installStoreContext();
  const loadSnapshot = () =>
    options.snapshot
      ? Promise.resolve(options.snapshot)
      : loadBagRegistrySnapshot();
  async function invocationStores(execution: WorkflowActorContext, node: string): Promise<StoreContext> {
    installStoreContext();
    const snapshot = await loadSnapshot();
    let localIdentityId: number | undefined;
    if (execution.identity) {
      try { localIdentityId = installationRegistry().legacyIdentityId(execution.identity); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "unknown local identity") throw error;
      }
    }
    const identity = localIdentityId === undefined ? undefined : await identityRecords.row(localIdentityId);
    const configurations = identity ? identityRecords.config(identity).bag_configs : {};
    const bags = Object.fromEntries(snapshot.bags
      .filter((bag) => bag.manifest?.stores)
      .map((bag) => [bag.name, { stores: bag.manifest!.stores!, overrides: configurations[bag.name]?.stores }]));
    return {
      node, identity: execution.identity, execution, bags,
      workflowActor: installationWorkflowActor(execution),
    };
  }
  const cleanup = new Set<() => Promise<void>>();
  let closeHttp: (() => Promise<void>) | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const abort = () => {
    void close();
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      closed = true;
      options.signal?.removeEventListener("abort", abort);
      try {
        await closeHttp?.();
      } finally {
        await Promise.allSettled([...cleanup].map((operation) => operation()));
      }
    })());

  // Must run before any dynamic bag import (see ts-specifier-hook.ts)

  // Teaches the loader to discover remote bags over MCP. The loader holds only
  // the local path so that bags can import it without reaching host code; the
  // host supplies the remote half. Without this, the 8 remote bags load from
  // their registry entry alone.

  const log = createLogger("mcp", { transport: "stderr" });
  // Credential resolution needs an identities store and must not import a bag to
  // get one. The engine already holds it, and this is the composition root.
  setIdentityStore({ get: identityRecords.row, resolveConfig: identityRecords.config, touchLastUsed: identityRecords.touch });

  // The bag tools served here reach models — semantic recall embeds, typed
  // judgments decide — through the one install every process that hosts bags performs.
  // Without it every such tool failed over MCP while working in the API. What it
  // installs is named here because naming it is this root's job: the shipped
  // catalog plus installed adapters' vendor code, loaded from their records.
  async function initializeModels(): Promise<void> {
    const shippedVendorRows = registeredVendorRows();
    const installedAdapters = loadAdapters({ file: barryAdaptersPath() });
    const installedVendorCode = await installedAdapters.loadVendorCode();
    for (const [id, problems] of installedVendorCode.refused) {
      log.error("models.vendor-code-refused", { adapter: id, problems });
    }
    const providers = loadModelVendors({ file: barryModelVendorsPath() });
    const providerFactories = await providers.load();
    for (const [packageName, problems] of providers.refused) {
      log.error("models.provider-refused", { packageName, problems });
    }
    installModels(
      createModels(
        assembleVendors(
          [
            ...shippedVendorRows,
            ...installedAdapters
              .installed()
              .filter((r) => !r.bag)
              .flatMap((r) => r.vendorCode?.vendors ?? []),
          ],
          mergeVendorFactories(
            providerFactories,
            installedVendorCode.factories,
          ),
        ),
      ),
    );
    const selfTest = selfTestModels();
    cleanup.add(() => selfTest);
  }

  /**
   * One real embed at boot, logged either way, so the log says whether recall
   * can work rather than leaving it to the first user who tries. Never blocks
   * boot: a daemon that is down is reported, not fatal.
   */
  async function selfTestModels(): Promise<void> {
    // Configurable rather than hard-wired: an installation that ships a
    // different default embedding model self-tests the model it actually uses.
    const model = (process.env.BARRY_SELF_TEST_EMBED_MODEL || "ollama/nomic-embed-text") as `${string}/${string}`;
    try {
      await installedModels()
        .embedding(model)
        .embed({ input: ["boot self-test"], timeoutMs: 15_000 });
      log.info("models.self_test", {
        ok: true,
        model,
      });
    } catch (err) {
      log.warn("models.self_test", {
        ok: false,
        model,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const mode = options.mode ?? "http";
  if (mode === "http") {
    const envCheck = validateEnv({ service: "mcp" });
    if (!envCheck.ok) {
      for (const m of envCheck.missing)
        log.error("env.required", { var: m.name, description: m.description });
      throw new Error("MCP application configuration or binding failed");
    }
    if (!process.env.BARRY_SECRET) {
      log.error("env.required", {
        var: "BARRY_SECRET",
        description: "Authenticates MCP clients",
      });
      throw new Error("MCP application configuration or binding failed");
    }
  }
  // The service management assigns the port (PORT); in stdio mode there is none. A
  // smoke test runs an isolated engine by giving it its own PORT and BARRY_HOME.
  const port = mode === "http" ? (options.port ?? assignedPort()) : 0;

  /**
   * A bag-contributed MCP resource registration and the loaded toolset shape
   * live in ./bag-loading.ts alongside the loader that produces them.
   */
  const bagToolDefinitions = new Map<string, RuntimeTool[]>();

  async function loadToolset(
    snapshot: BagRegistrySnapshot,
  ): Promise<LoadedToolset> {
    return loadBagTools(snapshot, log, bagToolDefinitions);
  }

  /**
   * Read an identity's environment (vault + file + inline + keychain sources).
   * Returns the values, or an empty map when the identity has none / cannot be
   * read — the bag path DEGRADES by dropping tools, it never refuses a session;
   * refusal is the session gate's job at the harness boundary.
   *
   * The work lives in `@barry-rocks/sdk/internal/env` so bag services build an
   * identity environment the same way rather than reimplementing it. A short cross-process TTL: edits in other processes are seen within 90 s.
   * Local mutations invalidate immediately; BARRY_IDENTITY_ENV_TTL_MS=0 disables caching.
   */
  async function resolveIdentityCredentials(
    identityId: number,
  ): Promise<Record<string, string>> {
    try {
      return (await buildIdentityEnvironmentShared(identityId, { log, cacheTtlMs: Math.max(0, Number(process.env.BARRY_IDENTITY_ENV_TTL_MS ?? 90_000)) })).vars;
    } catch (err) {
      log.warn("identity.environment_build_failed", {
        identityId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }


  async function identityToolVisibility(allTools: RuntimeTool[], identity: IdentityRecord): Promise<RuntimeTool[]> {
    const configuration = identityRecords.config(identity);
    const snapshot = await loadSnapshot();
    for (const [bagName, overrides] of Object.entries(configuration.bag_configs ?? {})) {
      if (!overrides.tools) continue;
      const definitions = bagToolDefinitions.get(bagName);
      if (!definitions) throw new Error(`${bagName}: tool overrides require a loaded tool module`);
      const bag = snapshot.bags.find(bag => bag.name === bagName);
      const ids = new Set(definitions.map(tool => qualifyToolId(tool.namespace, tool.name)));
      allTools = [
        ...allTools.filter(tool => !ids.has(qualifyToolId(tool.namespace, tool.name))),
        ...applyToolVisibility(definitions, bag?.manifest?.toolVisibility ?? {}, overrides.tools),
      ];
    }
    return allTools;
  }

  // Session tool resolution + its short-lived cache live in
  // ./session-tools-resolver.ts; wire the composition-root closures it needs.
  const { resolveSessionTools, invalidate: invalidateSessionResolve } =
    createSessionToolsResolver({
      log,
      resolveIdentityCredentials,
      identityToolVisibility,
      invocationStores,
    });

  async function startStdio(
    allTools: RuntimeTool[],
    resourceRegistrars: BagResourceRegistrar[] = [],
  ) {
    let identityBagNames: string[] | undefined;
    if (options.identityId !== undefined) {
      const identity = await identityRecords.row(options.identityId);
      if (!identity) throw new Error(`identity ${options.identityId} not found`);
      allTools = await identityToolVisibility(allTools, identity);
      identityBagNames = expandComposition(identityRecords.config(identity).bags, (await loadSnapshot()).byName);
    }
    const installation = installationRegistry();
    const resolvedEnv = options.identityId === undefined ? {} :
      (await buildIdentityEnvironmentShared(options.identityId, { log })).vars;
    const identityName =
      options.identityId === undefined
        ? undefined
        : installation.identityId(options.identityId);
    const scope = await sessionBound(ANONYMOUS_SESSION_ID, toToolMeta(allTools), {
      identityId: options.identityId,
      harness: options.harness,
      identity: identityName,
    });
    const execution: WorkflowActorContext = {
      ...(identityName === undefined ? {} : { identity: identityName }),
      bags: scope.bags,
      bounds: scope.bounds,
      harness: scope.harness,
      bound: scope.bound,
      allowedToolIds: [...scope.allowedToolIds],
    };
    const allowedCandidates = allTools.filter((tool) =>
      scope.allowedToolIds.has(qualifyToolId(tool.namespace, tool.name)),
    );
    allTools = Barry.tools<RuntimeTool>(
      {
        name: identityName,
        node: installation.id,
        storeContext: () => invocationStores(execution, installation.id),
      },
      allowedCandidates,
      scope.bound ?? {},
    );
    allTools = wrapForServing(allTools, [], resolvedEnv, null, { advertiseCallable: true, bagNames: identityBagNames });
    const visibleNamespaces = new Set(allTools.map(tool => tool.namespace));
    const server = createToolServer({
      tools: allTools,
      bound: scope.bound,
      resourceRegistrars: resourceRegistrars.filter(r => visibleNamespaces.has(r.namespace)
        && (identityBagNames === undefined || identityBagNames.includes(r.bag))).map(
        (r) => (server: McpServer) =>
          r.register(server, { secrets: pickEnv(resolvedEnv, r.secrets) }),
      ),
    });
    const transport = new StdioServerTransport();
    cleanup.add(() => server.close());
    await server.connect(transport);
    log.info("server.start", { mode: "stdio", toolCount: allTools.length });
  }

  /** Concurrent agent sessions allowed. Each may hold one transport per namespace. */
  const MAX_AGENT_SESSIONS = 50;
  /** Absolute transport ceiling — a memory backstop, not the real limit. */
  const MAX_TRANSPORTS = 400;
  /**
   * Ceiling on transports with no ?sessionId= (probes, health checks, ad-hoc
   * curl). They own no agent session, so MAX_AGENT_SESSIONS does not bound them —
   * without a separate cap a burst fills MAX_TRANSPORTS and locks out real
   * sessions until the idle sweep runs.
   */
  const MAX_ANONYMOUS_TRANSPORTS = 100;
  // 8 hours idle. Claude Code caches its mcp-session-id for the lifetime of the
  // host session and does not re-initialize on 404 (see
  // github.com/anthropics/claude-code/issues/27142), so an aggressive sweep
  // permanently bricks the barry namespace for any conversation that goes quiet
  // for a while. The caps bound memory; the TTL only needs to reap sessions
  // from long-gone hosts.
  const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
  // Warn before transport accumulation exhausts the hard cap so reclamation failures remain diagnosable.
  // Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-015
  const LEAK_WARN_TRANSPORTS = 250;

  // Session transport map + last-activity tracking
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const lastActivity: Record<string, number> = {};
  // Connection ownership includes reservations made before transport registration.
  // Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
  const connectionLeases = new ConnectionLeases();
  // Agent session (barrySessionId) each transport belongs to. One agent session
  // opens one transport per namespace, so the cap must count agent sessions —
  // counting transports would let ~5 agents exhaust a 50-transport budget.
  const transportOwner: Record<string, string> = {};
  const workflowRequests = new WeakMap<express.Request, WorkflowSessionCredential>();
  const workflowAuthorizations = new WeakMap<express.Request, WorkflowAuthorization>();
  const retainedWorkflowRequests = new WeakSet<express.Request>();
  async function verifyWorkflowOwner(credential: WorkflowSessionCredential): Promise<void> {
    if (await access.operator() !== credential.actorId
      || await identityRecords.actorOf(credential.identityId) !== credential.actorId) throw new Error("Workflow ownership is unavailable");
  }
  const transportAuthorization = new TransportAuthorization(request => workflowRequests.get(request),
    request => workflowAuthorizations.get(request)?.check() ?? Promise.resolve(false),
    request => { retainedWorkflowRequests.delete(request); workflowAuthorizations.get(request)?.dispose(); });
  // The one live transport each (agent session, namespace) pair may occupy.
  // Keyed by slotKey() -> mcpSessionId. A client that re-initializes supersedes
  // its own predecessor here instead of abandoning it (see transport-slots.ts).
  const transportSlots: Record<string, string> = {};
  // Namespace each transport serves ("" for the core /mcp endpoint).
  const transportNamespace: Record<string, string> = {};
  // Live tool-server handle per transport, kept so a bag change can re-scope an
  // already-connected session (handle.refreshTools) and notify its client. The
  // transport alone is not enough: notifications and list swaps live on the
  // McpServer, which was previously dropped after connect.
  const toolServers: Record<string, ToolServerHandle> = {};
  // Namespaces the aggregate transport agreed NOT to serve (its `split=` set,
  // fixed by the client's config at launch). A refresh must keep honoring it, or
  // every split tool would reappear on the aggregate and reach the agent twice.
  const transportSplit: Record<string, Set<string>> = {};
  // Synchronous admission reservations for transports mid-initialize — closes
  // the TOCTOU window between admitTransport()'s check and registerTransport()'s
  // actual state write, which happens only after `resolveSessionTools` has run
  // (; see transport-slots.ts for the full rationale).
  const pendingAdmissions = new PendingAdmissions();

  /**
   * The one wrapping chain between resolved session tools and a served server:
   * secret/session-id injection, edit recording, edit intent + read tracking,
   * and the shell edit guard.
   *
   * Shared by both endpoint initializes AND refreshSessionTransports — a refresh
   * that skipped any of these wrappers would serve unguarded tools, which is
   * strictly worse than serving stale ones. Scope guards are NOT here: they are
   * applied inside resolveSessionToolsUncached, so every resolution result
   * arrives already guarded.
   *
   * `advertiseCallable` passes the session's callable tool names into handlers
   * (find_actions uses it to warn about unmet requirements) — descriptive only,
   * and only the aggregate endpoint does it, matching prior behavior.
   */
  function wrapForServing(
    tools: RuntimeTool[],
    proxiedTools: FilterableProxiedTool[],
    resolvedEnv: Record<string, string>,
    barrySessionId: string | null,
    opts: { advertiseCallable: boolean; bagNames?: string[] },
  ): RuntimeTool[] {
    const callableToolNames = opts.advertiseCallable
      ? [...tools.map((t) => t.name), ...proxiedTools.map((t) => t.name)]
      : undefined;
    // bagNames is passed on every endpoint, unlike callable tool names: a catalog
    // tool is just as wrong about the session when reached through a namespace
    // endpoint, and listing another bag's prose there costs the same confusion.
    let out = wrapSecretInjection(
      tools,
      resolvedEnv,
      barrySessionId ?? undefined,
      callableToolNames,
      opts.bagNames,
    );
    if (barrySessionId) {
      // Only with a real session to attribute them to — otherwise edits recorded
      // under "unknown" are noise. Edit intent claims the file; read tracking
      // runs BEFORE claiming so a stale edit fails without claiming anything.
      out = wrapEditRecording(out, barrySessionId);
      out = wrapEditIntent(
        out,
        barrySessionId,
        createEditArbiter(barrySessionId),
      );
      out = wrapReadTracking(out, barrySessionId);
    }
    // Outside the barrySessionId branch on purpose: routing a file write
    // through the edit tools is right for every caller, including anonymous
    // sessions, which previously kept a fully unguarded shell.
    return wrapShellEditGuard(out);
  }


  /** Port bound + gate + app shared between earlyBind and startHttp. */
  interface HttpBootContext {
    app: express.Express;
    /** Resolves once the port is bound; the process exits if it cannot be. */
    listening: Promise<HttpServer>;
    gate: ReadinessGate;
    shutdownHooks: Set<() => Promise<void>>;
  }

  /**
   * Bind the port IMMEDIATELY at boot, before the toolset and bag pool load.
   *
   * `kickstart -k` kills the previous process first, so until this ran the port
   * was simply unbound for the whole 60-90s boot — every client saw
   * ECONNREFUSED. Now /health answers from t≈0, status routes fast-fail with
   * Retry-After (their clients have safe fallbacks), and the /mcp protocol
   * routes PARK on the readiness gate: startHttp registers them later on this
   * same app (express dispatches into late-registered routes — see
   * readiness.ts) and resolves the gate once the COMPLETE toolset is live, so
   * no session ever sees a partial one.
   */
  function earlyBind(): HttpBootContext {
    const app = express();
    const shutdownHooks = new Set<() => Promise<void>>();
    app.use(express.json({ limit: "1mb" }));
    app.use((_req, res, next) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      next();
    });

    const operatorAuth = authorizeRequest({ verifyCredential: access.verifyCredential, policy: () => null });
    app.use((req, res, next) => {
      if (req.path === "/health") return next();
      const token = requestCredential(req);
      if (!token?.startsWith("bws3.")) return operatorAuth(req, res, next);
      const secret = process.env.BARRY_SECRET;
      if (!secret) return res.status(500).json({ error: "server credential is unavailable" });
      void (async () => {
        const cancellation = new AbortController();
        const cancel = () => cancellation.abort();
        req.once("aborted", cancel); res.once("close", cancel);
        if (req.aborted || res.destroyed || res.writableEnded) cancel();
        let authorization: WorkflowAuthorization | undefined;
        try {
          if (!(req.path === "/mcp" || req.path.startsWith("/mcp/ns/"))) throw new Error("credential cannot access this route");
          const credential = verifyWorkflowSessionCredential(token, secret);
          if (req.query.sessionId !== credential.sessionId) throw new Error("session binding is unavailable");
          authorization = new WorkflowAuthorization(token, async (bearer, signal) => {
            signal.throwIfAborted();
            const currentSecret = process.env.BARRY_SECRET;
            const currentIdentity = sessionIdentity(credential.sessionId);
            if (!currentSecret || !currentIdentity) throw new Error("session binding is unavailable");
            const current = await withStoreContext({ identity: currentIdentity }, () => getSession(credential.sessionId));
            signal.throwIfAborted();
            verifyWorkflowSessionCredentialForSession(bearer, currentSecret, credential.sessionId, current);
            await verifyWorkflowOwner(credential);
            signal.throwIfAborted();
            if (currentSecret !== process.env.BARRY_SECRET) throw new Error("credential changed");
          });
          if (!await authorization.check(cancellation.signal) || req.aborted || res.destroyed || res.writableEnded) throw new Error("authorization unavailable");
          workflowRequests.set(req, Object.freeze(credential));
          workflowAuthorizations.set(req, authorization);
          res.once("close", () => { if (!retainedWorkflowRequests.has(req)) authorization?.dispose(); });
          next();
        } catch {
          authorization?.dispose();
          if (!req.aborted && !res.destroyed && !res.writableEnded) res.status(401).json({ error: "invalid or stale workflow session credential" });
        } finally {
          req.removeListener("aborted", cancel); res.removeListener("close", cancel); cancellation.abort();
        }
      })();
    });
    app.use(transportAuthorization.middleware);

    /**
     * Request logging. The MCP server had none — no durations, no status codes,
     * no route breakdown — so the only thing observable about it was whether the
     * process was alive. A wedged-but-answering server looked identical to a
     * healthy one, which is how it 503'd every new session for hours while
     * /health reported "ok".
     *
     * /health is skipped: it is probed every 60s by the sampler and would be the
     * overwhelming majority of every log line and every latency percentile,
     * drowning out the traffic that matters.
     *
     * Mounted after authentication so unauthenticated probes do not fill the log, and
     * after the transport routes' own logging so the two do not double-count.
     */
    app.use(
      createRequestLogger("mcp", {
        skip: (req: express.Request) => req.path === "/health",
        // stdout is the MCP protocol stream here; request logs belong on stderr.
        transport: "stderr",
      }),
    );

    // Authentication precedes readiness so boot never parks unauthenticated requests.
    // Service control does not wait for the toolset.
    app.use("/api/v1/services", servicesRouter());
    const gate = createReadinessGate();
    app.use(
      gateMiddleware(gate, {
        openPaths: ["/health"],
        // Their clients treat any !ok response as "no data, use the fallback"
        // (session-runtime's bag-status fetch has NO timeout — holding it would
        // block every session start for the whole boot).
        fastFailPaths: ["/bag-status", "/bag-retry", "/session-namespaces"],
      }),
    );

    /**
     * Liveness plus the transport gauge.
     *
     * The plain-text "ok" is preserved as a field rather than dropped: the
     * services bag's health-check job greps this body for "ok", so changing
     * the shape alone would have quietly broken the check that has run every
     * five minutes for months.
     *
     * `transports` is the number this endpoint most needs to report. The 2026-08
     * leak climbed to 1,628 live against a ceiling of 400 while this route
     * returned "ok" throughout — the process was healthy and still serving
     * existing clients, and only 503'd NEW sessions. A leak is a slope, so the
     * count has to be readable from outside to be trended at all.
     */
    app.get("/health", (_req, res) => {
      res.json({
        ok: true,
        transports: Object.keys(transports).length,
        maxTransports: MAX_TRANSPORTS,
        leakWarnTransports: LEAK_WARN_TRANSPORTS,
        ready: gate.state(),
        bootError: gate.error(),
      });
    });

    /**
     * Live transports attributed by namespace and by owning agent session.
     *
     * Separate from /health deliberately: /health is probed every 60s and must stay
     * a constant-time read of one counter, while this walks every live transport.
     * Cheap at 400, but not work to add to a liveness probe.
     *
     * The scalar in /health cannot answer what this is for. With one namespace per
     * bag a client opens ~46 transports at once, so "108 live" says nothing about
     * whether the fan-out is uniform, whether one namespace is churning, or which
     * session is responsible — the questions that decide whether the per-bag proxy
     * topology costs anything. `perSession` reports it as a slope, not a level.
     */
    app.get("/transports", (_req, res) => {
      res.json({
        ok: true,
        ...attributeTransports(
          Object.keys(transports),
          transportNamespace,
          transportOwner,
        ),
        maxTransports: MAX_TRANSPORTS,
        leakWarnTransports: LEAK_WARN_TRANSPORTS,
      });
    });

    // Bind loopback only — every MCP client (CLI config, session-runtime, identities
    // route, health-check) connects via localhost/127.0.0.1, so there is no need
    // to expose this host-tool-execution surface on all interfaces.
    const listening = listenOnAssignedPort(app, { PORT: String(port) }).then(
      (server) => {
        log.info("server.listening", { mode: "http", port, host: LOOPBACK });
        return server;
      },
      (err: Error) => {
        log.error("server.listen_failed", { port, error: err.message });
        throw new Error("MCP application configuration or binding failed");
      },
    );

    // Registered HERE, not after the toolset loads: with the port bound early, a
    // signal during boot must settle the gate (parked handlers flush a clean 503
    // instead of a dropped socket) and stop accepting before exiting.
    const shutdown = async () => {
      log.info("server.shutdown");
      gate.reject(new Error("server shutting down"));
      const server = await listening.catch(() => undefined);
      if (server) {
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeIdleConnections();
        server.closeAllConnections();
        await stopped;
      }
      await Promise.allSettled(
        [...shutdownHooks].map(async (close) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              close(),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 5000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      // Before closing transports: a pending restart timer would otherwise
      // respawn a bag server on the way out.
      for (const transport of Object.values(transports)) {
        try {
          await transport.close();
        } catch {
          // ignore cleanup errors
        }
      }
    };
    closeHttp = shutdown;

    return { app, listening, gate, shutdownHooks };
  }

  async function startHttp(
    ctx: HttpBootContext,
    allTools: RuntimeTool[],
    pool: BagConnectionPool,
    resourceRegistrars: BagResourceRegistrar[] = [],
  ) {
    const { app, gate } = ctx;
    // Rate limit per IP, covering /mcp and /mcp/ns/*.
    //
    // Every client is on loopback, so this is a runaway-loop backstop rather than
    // an abuse control, and the ceiling has to clear a burst of session *starts*.
    // A client opens one connection per entry at once — ~13 namespaces plus the
    // aggregate — and each is an initialize followed by a tools/list, so one
    // session start is ~28 requests. Eight starting together is ~224, already past
    // a 200/s ceiling; at the original 20/s a single session silently came up
    // missing tools. 1000/s keeps ~4x headroom over that worst case while still
    // catching a genuine runaway loop.
    const mcpRateLimiter = createRateLimiter(1000, 1000, log);
    app.use("/mcp", mcpRateLimiter);

    // Read/retry control routes (/session-namespaces, /bag-status, /bag-retry)
    // live in ./control-routes.ts.
    registerControlRoutes({ app, pool, allTools, resolveSessionTools, log });

    // Live-transport re-scoping (refreshSessionTransports, the resolve-retry
    // self-heal, and the /refresh-tools route) lives in ./transport-refresh.ts.
    const { scheduleResolveRetry } = createTransportRefresh({
      app,
      pool,
      allTools,
      log,
      shutdownHooks: ctx.shutdownHooks,
      transportOwner,
      transportNamespace,
      transportSplit,
      toolServers,
      connectionLeases,
      resolveSessionTools,
      invalidateSessionResolve,
      wrapForServing,
    });

    /**
     * Admission control for a new transport.
     *
     * Namespace endpoints multiply transports per agent session, so the real limit
     * is on distinct agent sessions; MAX_TRANSPORTS is only a memory backstop.
     * Transports belonging to an already-admitted agent session always pass —
     * rejecting them would leave that session with a partial toolset, and Claude
     * Code caches its mcp-session-id rather than re-initializing (see SESSION_TTL_MS).
     *
     * Returns a reservation id on admission, `null` on rejection. The caller MUST
     * release the id exactly once — either by reaching `registerTransport` (which
     * releases it once the real `transports`/`transportOwner` state takes over) or,
     * on any failure/early-return before that, by calling
     * `pendingAdmissions.release(id)` directly. Folding `pendingAdmissions`'s counts
     * into the check closes the gap between this synchronous decision and
     * `registerTransport`'s write, which today happens only after
     * `resolveSessionTools` has already run its DB lookups and possible bag
     * connects — without this, concurrent initializes can each read the same
     * under-cap live counts and all pass, overshooting both caps.
     */
    function admitTransport(barrySessionId: string | null): number | null {
      const liveOwners = Object.values(transportOwner);
      const distinctOwners = new Set([
        ...liveOwners,
        ...pendingAdmissions.distinctSessionIds(),
      ]);
      const admitted = admitTransportDecision({
        barrySessionId,
        totalTransports:
          Object.keys(transports).length + pendingAdmissions.count(),
        ownedTransports: liveOwners.length + pendingAdmissions.count(),
        distinctOwners,
        maxTransports: MAX_TRANSPORTS,
        maxAnonymous: MAX_ANONYMOUS_TRANSPORTS,
        maxAgentSessions: MAX_AGENT_SESSIONS,
      });
      if (!admitted) return null;
      return pendingAdmissions.reserve(barrySessionId);
    }

    /**
     * Release every map entry for one transport. Single source of truth so the
     * two creation sites (/mcp and /mcp/ns/:namespace) cannot drift apart.
     *
     * Clears the slot only if it still points at THIS transport — a successor has
     * already claimed it during a supersede, and stomping that would strand the
     * live transport with no slot and let the next re-init leak again.
     */
    function releaseTransport(sid: string): void {
      transportAuthorization.release(sid);
      const owner = transportOwner[sid];
      const ns = transportNamespace[sid];
      if (owner && ns !== undefined) {
        const key = slotKey(owner, ns);
        if (transportSlots[key] === sid) delete transportSlots[key];
      }
      delete transports[sid];
      delete lastActivity[sid];
      connectionLeases.release(sid);
      delete transportOwner[sid];
      delete transportNamespace[sid];
      delete toolServers[sid];
      delete transportSplit[sid];
    }

    /** Replace the prior transport slot, commit pool leases and release its admission; see docs/decisions/0018-mcp-transport-and-action-metadata.md. */
    function registerTransport(
      sid: string,
      transport: StreamableHTTPServerTransport,
      barrySessionId: string | null,
      namespace: string,
      activePoolKeys: string[],
      admissionId: number,
      request: express.Request,
    ): void {
      transportAuthorization.bind(sid, request, transport, () => releaseTransport(sid));
      if (workflowAuthorizations.has(request)) retainedWorkflowRequests.add(request);
      pendingAdmissions.release(admissionId);
      const superseded = findSupersededTransport(
        transportSlots,
        barrySessionId,
        namespace,
      );
      if (superseded && superseded !== sid) {
        const stale = transports[superseded];
        log.info("session.superseded", {
          mcpSessionId: superseded,
          replacedBy: sid,
          barrySessionId: barrySessionId ?? undefined,
          namespace,
        });
        releaseTransport(superseded);
        // After releaseTransport so the onclose handler finds nothing to redo.
        if (stale)
          void Promise.resolve(stale.close()).catch(() => {
            /* already closed */
          });
      }

      transports[sid] = transport;
      lastActivity[sid] = Date.now();
      transportNamespace[sid] = namespace;
      if (barrySessionId) {
        transportOwner[sid] = barrySessionId;
        transportSlots[slotKey(barrySessionId, namespace)] = sid;
      }
      connectionLeases.commit(sid, activePoolKeys);

      const live = Object.keys(transports).length;
      if (live > LEAK_WARN_TRANSPORTS) {
        log.warn("transport.high_water", {
          live,
          maxTransports: MAX_TRANSPORTS,
        });
      }
    }

    /**
     * Close transports whose owning agent session is gone.
     *
     * A `claude` process that is killed (or crashes) never closes its HTTP
     * transport, so `transport.onclose` never fires and its pool keys stay
     * owned in `connectionLeases` forever. `pruneUnused` then reads those keys
     * as live and keeps the session-scoped bag server alive for the full
     * SESSION_TTL_MS — which for a browser bag means a headless Chrome idling
     * for 8 hours.
     *
     * Liveness comes from the API's active-session list (`findDeadSessions`),
     * not the DB `status` column, which rests at "pending" between turns. That
     * probe fails OPEN: unknown liveness yields an empty dead set, so a
     * momentarily unreachable API degrades to TTL-only reaping rather than
     * killing every live session's tools.
     *
     * Anonymous transports have no `transportOwner` entry and are deliberately
     * untouched here — they are bounded by MAX_ANONYMOUS_TRANSPORTS instead.
     */
    async function closeTransportsForDeadSessions(): Promise<void> {
      const owners = Object.entries(transportOwner);
      if (owners.length === 0) return;

      let dead: Set<string>;
      try {
        const { findDeadSessions } = await import(
          "@barry-rocks/locks-bag"
        );
        dead = await findDeadSessions(owners.map(([, owner]) => owner));
      } catch (err) {
        log.debug("session.liveness_probe_failed", { error: String(err) });
        return;
      }
      if (dead.size === 0) return;

      for (const [sid, owner] of transportsWithDeadOwners(
        transportOwner,
        dead,
      )) {
        if (!transports[sid]) continue;
        log.info("session.dead_owner_cleanup", {
          mcpSessionId: sid,
          sessionId: owner,
        });
        // onclose deletes transports/lastActivity/connectionLeases ownership/transportOwner.
        try {
          await transports[sid].close();
        } catch {
          /* transport already closed */
        }
        releaseTransport(sid);
      }
    }

    // Periodic cleanup of idle sessions + unused pool connections
    const cleanupTimer = setInterval(async () => {
      const now = Date.now();
      for (const [sid, lastSeen] of Object.entries(lastActivity)) {
        if (now - lastSeen > SESSION_TTL_MS && transports[sid]) {
          log.info("session.idle_cleanup", { sessionId: sid });
          try {
            await transports[sid].close();
          } catch {
            /* transport already closed */
          }
          releaseTransport(sid);
        }
      }

      // Drop transports whose agent session died without closing them, so their
      // pool keys stop pinning heavyweight bag servers for the full TTL.
      await closeTransportsForDeadSessions();

      // Per-session read-tracking state: evict sessions that no longer own a
      // transport and have gone idle (see session-state.ts for why not
      // releaseTransport).
      sweepSessionState(new Set(Object.values(transportOwner)));

      // Pruning must protect both committed owners and pending reservations.
      // Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
      pool.pruneUnused(connectionLeases.activeKeys());
    }, 60_000);
    cleanupTimer.unref();
    ctx.shutdownHooks.add(async () => {
      clearInterval(cleanupTimer);
    });

    /**
     * Unified transport admission + session resolve + transport lifecycle for
     * BOTH POST routes. The ONLY behavioural divergence is the tool-resolution
     * step, selected on `opts.namespace`:
     *
     *   - absent (aggregate `/mcp`): serve every namespace the session resolves
     *     to, minus any mounted as their own `/mcp/ns/<ns>` entry (the `split`
     *     query param), plus the global deferred catalog in barry mode.
     *     Advertises callable names and gates resources by the surviving tools.
     *
     *   - set (`/mcp/ns/:namespace`): filter the resolved tools to that one
     *     namespace, emit `session.ns_scoped`, fail CLOSED per-namespace, and
     *     synthesize a `*_needs_auth` tool when the bag is unauthorized. Never
     *     advertises callable names; marks the server namespace-scoped.
     *
     * Everything else — admission, the pending-admission release contract, the
     * transport object, onsessioninitialized/onclose, wrapForServing, the
     * revalidate gate, handle creation/connect, retry scheduling — is shared and
     * byte-faithful to the two handlers it replaces.
     */
    async function handleMcpRequest(
      req: express.Request,
      res: express.Response,
      opts: { namespace?: string },
    ): Promise<void> {
      const namespace = opts.namespace;
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      try {
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId];
          lastActivity[sessionId] = Date.now();
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // Filter tools when a Barry session is present in query params.
          const urlParams = new URL(req.url, `http://${req.headers.host}`)
            .searchParams;
          const barrySessionId = urlParams.get("sessionId");

          const admissionId = admitTransport(barrySessionId);
          if (admissionId === null) {
            res.status(503).json({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Too many active sessions" },
              id: null,
            });
            return;
          }
          // Released by registerTransport() on success; this covers every OTHER
          // exit from the block below (a thrown error, a response sent before
          // onsessioninitialized ever fires) — release() is idempotent, so
          // double-releasing the success path's already-released id is a no-op.
          try {
            // Fail-closed initial values: every path below assigns them, so these
            // only ever serve if a new path forgets to — and empty is the mistake
            // that gets noticed, where "all tools" was the mistake that got kept.
            let sessionTools: RuntimeTool[] = [];
            let sessionProxiedTools: FilterableProxiedTool[] = [];
            let activePoolKeys: string[] = [];
            let resolvedEnv: Record<string, string> = {};
            let toolDiscovery: "provider" | "barry" | undefined;
            let sessionBagNames: string[] | undefined;
            let sessionBound: Bound | null = null;

            // Namespaces this session also mounts as their own `/mcp/ns/<ns>` entry.
            // Serving them here too would hand the agent every split tool twice —
            // once as mcp__git__status, once as mcp__barry__git_status — doubling
            // tool-list tokens and leaving it to guess which to call. Only ever
            // populated on the aggregate route; namespace endpoints ignore it.
            const splitNamespaces = new Set(
              namespace
                ? []
                : (urlParams.get("split") ?? "")
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
            );

            // Anonymous initializes receive the base-identity scope; see docs/decisions/0018-mcp-transport-and-action-metadata.md.
            const scopeSessionId = barrySessionId ?? ANONYMOUS_SESSION_ID;
            let resolveFailed = false;
            {
              try {
                const result = await resolveSessionTools(
                  scopeSessionId,
                  allTools,
                  pool,
                );
                if (namespace) {
                  // Namespace endpoint: filter the resolved tools to this one
                  // namespace and record what survived. Same scope decision as
                  // the aggregate — just narrowed to one entry's prefix.
                  sessionTools = result.sessionTools.filter(
                    (t) => t.namespace === namespace,
                  );
                  sessionProxiedTools = result.sessionProxiedTools.filter(
                    (t) => t.namespace === namespace,
                  );
                } else {
                  sessionTools = result.sessionTools;
                  sessionProxiedTools = result.sessionProxiedTools;
                }
                activePoolKeys = result.activePoolKeys;
                resolvedEnv = result.resolvedEnv;
                toolDiscovery = result.toolDiscovery;
                sessionBagNames = result.identityBagNames;
                sessionBound = result.bound ?? null;
                if (namespace) {
                  log.info("session.ns_scoped", {
                    barrySessionId: scopeSessionId,
                    namespace,
                    localTools: sessionTools.length,
                    proxiedTools: sessionProxiedTools.length,
                  });
                }
              } catch (error) {
                // Serve no tools on resolution failure and retry on backoff; see
                // docs/decisions/0018-mcp-transport-and-action-metadata.md. Fail
                // CLOSED identically on both routes: the anonymous-view default
                // must not survive a resolve error for a session that asked to be
                // scoped.
                resolveFailed = true;
                sessionTools = [];
                sessionProxiedTools = [];
                log.error("scope.resolve_error", {
                  barrySessionId: scopeSessionId,
                  ...(namespace ? { namespace } : {}),
                  served: barrySessionId
                    ? "no tools; retry scheduled"
                    : "no tools",
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }

            if (!namespace && splitNamespaces.size > 0) {
              const before = sessionTools.length + sessionProxiedTools.length;
              const present = new Set([
                ...sessionTools.map((t) => t.namespace),
                ...sessionProxiedTools.map((t) => t.namespace),
              ]);
              // Deferred tools stay, even for a split namespace, and ONLY in barry
              // mode. The split exists to stop a tool reaching the agent twice —
              // once as mcp__git__status, once as mcp__barry__git_status — but a
              // deferred tool is absent from tools/list on both endpoints
              // (`listedTools()` in tool-runtime), so keeping it here cannot double
              // it. What it does buy is the one thing barry-mode discovery needs: a
              // GLOBAL deferred index. Each /mcp/ns/<ns> server has its own registry, so
              // its tool_search only ever sees its own namespace and its call_tool
              // can only dispatch its own tools. Without this, an agent on
              // /mcp/ns/git cannot reach a deferred `changes` tool at all, and a
              // namespace that defers nothing has no search surface whatsoever.
              //
              // In provider mode this must NOT happen: there, deferred tools are
              // listed normally, so keeping split ones on the aggregate would
              // reintroduce exactly the double-listing the filter prevents.
              // Resolver, not a bare compare: `toolDiscovery` is undefined when no
              // identity chose, and the default is what decides which of the two
              // behaviours this comment describes actually applies.
              const keepsDeferred =
                resolveToolDiscovery(toolDiscovery) === "barry";
              const splitOut = (t: { namespace: string; deferred?: boolean }) =>
                splitNamespaces.has(t.namespace) &&
                !(keepsDeferred && t.deferred);
              sessionTools = sessionTools.filter((t) => !splitOut(t));
              sessionProxiedTools = sessionProxiedTools.filter(
                (t) => !splitOut(t),
              );

              // A name the session has no tools for means the client and server
              // disagree about the session's tool set — the client mounted an entry
              // that will come up empty. Cheap to log, invisible otherwise.
              const unknown = [...splitNamespaces].filter(
                (ns) => !present.has(ns),
              );
              if (unknown.length > 0) {
                log.warn("session.split_namespace_unknown", {
                  barrySessionId: barrySessionId ?? undefined,
                  namespaces: unknown,
                });
              }

              // The inverse of `unknown`, and the one that actually costs the user
              // tools: a namespace the session HAS tools for that the client never
              // mounted an entry for. Its tools stay on the aggregate, so they
              // reach the agent under the `barry` prefix
              // (mcp__barry__navigate_page) instead of their own, and nothing said
              // so.
              const orphaned = [...present].filter(
                (ns) => ns && !splitNamespaces.has(ns),
              );
              if (orphaned.length > 0) {
                log.warn("session.split_namespace_orphaned", {
                  barrySessionId: barrySessionId ?? undefined,
                  namespaces: orphaned,
                  hint: "granted after mcp.json was written; tools serve under the aggregate prefix until the session restarts",
                });
              }

              log.info("session.split_namespaces_excluded", {
                barrySessionId: barrySessionId ?? undefined,
                namespaces: [...splitNamespaces],
                removed:
                  before - (sessionTools.length + sessionProxiedTools.length),
              });
            }

            // Namespace endpoint only: when the namespace resolves to 0 tools
            // because its bag needs OAuth, inject a synthetic tool that points
            // the agent at bag_auth on the main barry MCP endpoint. Without this
            // the agent sees an empty list and no signal that auth is needed.
            if (namespace) {
              const bagNeedsAuth =
                pool.needsAuth[namespace] || pool.authExpired[namespace];
              if (
                sessionTools.length === 0 &&
                sessionProxiedTools.length === 0 &&
                bagNeedsAuth
              ) {
                sessionTools = [
                  {
                    namespace,
                    access: "read" as const,
                    name: `${namespace}_needs_auth`,
                    description:
                      `The "${namespace}" bag requires OAuth authorization before its tools are available. ` +
                      `Call the \`bag_auth\` tool on the main barry MCP server with { "bag": "${namespace}" } ` +
                      `to open a browser tab for the user to authorize, then retry your original request.`,
                    schema: {},
                    handler: async () => ({
                      content: [
                        {
                          type: "text" as const,
                          text: `The "${namespace}" bag is not authorized. Call the \`bag_auth\` tool with { "bag": "${namespace}" } to authorize it.`,
                        },
                      ],
                    }),
                  },
                ];
                log.info("session.ns_needs_auth", { namespace, barrySessionId });
              }
            }

            transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                registerTransport(
                  sid,
                  transport,
                  barrySessionId,
                  namespace ?? "",
                  activePoolKeys,
                  admissionId,
                  req,
                );
                log.info("session.created", {
                  mcpSessionId: sid,
                  barrySessionId: barrySessionId ?? undefined,
                  ...(namespace ? { namespace } : {}),
                  poolKeys:
                    activePoolKeys.length > 0 ? activePoolKeys : undefined,
                });
              },
            });

            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid) {
                releaseTransport(sid);
                log.info("session.closed", {
                  mcpSessionId: sid,
                  ...(namespace ? { namespace } : {}),
                });
              }
            };

            // Inject resolved barry secrets + the session id into tool handlers.
            // On the aggregate route, also pass the session's callable tool names
            // (native + proxied) so a tool can describe what this session can do —
            // find_actions uses it to warn about unmet requirements. Descriptive
            // only; the authorization decision already happened in the filter
            // above. Namespace endpoints never advertised callable names.
            // Secret/session injection + edit guards — the same chain the refresh
            // path applies, extracted so the two cannot drift (see wrapForServing).
            sessionTools = wrapForServing(
              sessionTools,
              sessionProxiedTools,
              resolvedEnv,
              barrySessionId,
              {
                advertiseCallable: !namespace,
                bagNames: sessionBagNames,
              },
            );

            // Resources ride along with their namespace: registered only when this
            // connection serves at least one tool of the bag's namespace, so
            // bound denial of a bag also denies its resources. On the aggregate
            // route, namespaces split to their own endpoint are not served twice;
            // on a namespace endpoint only that one namespace's registrars apply.
            const applicableRegistrars = resourceRegistrars.filter((r) =>
              namespace
                ? r.namespace === namespace &&
                  sessionTools.some((t) => t.namespace === namespace)
                : !splitNamespaces.has(r.namespace) &&
                  sessionTools.some((t) => t.namespace === r.namespace),
            );

            if (!await transportAuthorization.revalidate(req)) {
              res.status(403).json({ ok: false, error: "Forbidden" }); return;
            }
            const handle = createToolServerHandle({
              authorize: transportAuthorization.authorizeCall,
              tools: sessionTools,
              proxiedTools: sessionProxiedTools,
              pool,
              toolDiscovery,
              bound: sessionBound,
              ...(namespace ? { namespaceScoped: true } : {}),
              barrySessionId: barrySessionId ?? undefined,
              resourceRegistrars: applicableRegistrars.map(
                (r) => (s: McpServer) =>
                  r.register(s, {
                    secrets: pickEnv(resolvedEnv, r.secrets),
                    sessionId: barrySessionId ?? undefined,
                  }),
              ),
            });
            await handle.server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            // The initialize we just handled assigned the transport its id. Keep
            // the handle so a later bag change can re-scope THIS live server, and
            // (aggregate only) the split set so a refresh keeps honoring the
            // client's mount layout.
            const newSid = transport.sessionId;
            if (newSid) {
              toolServers[newSid] = handle;
              if (!namespace) transportSplit[newSid] = splitNamespaces;
            }
            if (resolveFailed && barrySessionId)
              scheduleResolveRetry(barrySessionId);
            return;
          } finally {
            pendingAdmissions.release(admissionId);
          }
        } else if (sessionId) {
          // Unknown session ID (expired via idle sweep or lost on restart).
          // Per the MCP Streamable HTTP spec this must be 404, not 400 —
          // clients respond to 404 by transparently re-initializing a new
          // session, so expiry/restarts become self-healing.
          log.info("session.not_found", {
            sessionId,
            ...(namespace ? { namespace } : {}),
          });
          res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found or expired" },
            id: null,
          });
          return;
        } else {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: No valid session ID provided",
            },
            id: null,
          });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        log.error("request.error", {
          ...(namespace ? { namespace } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    }

    /**
     * Shared GET (SSE stream) / DELETE (session termination) handler. Byte-identical
     * for the aggregate and namespace routes — the namespace param is addressing
     * only; the transport is keyed by mcp-session-id either way.
     */
    async function handleMcpStream(
      req: express.Request,
      res: express.Response,
    ): Promise<void> {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId) {
        res.status(400).send("Missing session ID");
        return;
      }
      if (!transports[sessionId]) {
        // 404 so clients re-initialize (see handleMcpRequest)
        res.status(404).send("Session not found or expired");
        return;
      }
      await transports[sessionId].handleRequest(req, res);
    }

    // Aggregate endpoint: serves every namespace the session resolves to.
    app.post("/mcp", (req, res) => handleMcpRequest(req, res, {}));
    // GET for SSE streams (server-to-client notifications); DELETE terminates.
    app.get("/mcp", handleMcpStream);
    app.delete("/mcp", handleMcpStream);

    // Each non-core namespace gets its own MCP endpoint so Claude sees tools
    // with proper bag prefixes (e.g. mcp__linear__ticket_get instead of
    // mcp__barry__ticket_get). Same server process, same BagConnectionPool —
    // and the SAME handleMcpRequest, so admission is covered on both routes.
    app.post("/mcp/ns/:namespace", (req, res) =>
      handleMcpRequest(req, res, { namespace: req.params.namespace }),
    );
    // GET/DELETE for namespace endpoints (SSE streams + session termination)
    app.get("/mcp/ns/:namespace", handleMcpStream);
    app.delete("/mcp/ns/:namespace", handleMcpStream);
    // Everything a session needs is registered; release the parked requests.
    gate.resolve();
    log.info("server.start", {
      mode: "http",
      port,
      host: LOOPBACK,
      toolCount: allTools.length,
    });
  }

  let httpCtx: HttpBootContext | undefined;
  try {
    const hook = registerTsSpecifierHook();
    cleanup.add(async () => hook.deregister());
    initFileTracker();
    cleanup.add(async () => closeFileTracker());

    // Bind the port before ANY loading (even the snapshot read) — see earlyBind.
    httpCtx = mode === "http" ? earlyBind() : undefined;
    options.signal?.addEventListener("abort", abort, { once: true });
    if (httpCtx) await httpCtx.listening;

    installRemoteBagLoader();

    await initializeModels()
      .then(() => loadSnapshot())
      .then(async (snapshot) => {
        const { tools: allTools, resourceRegistrars } =
          await loadToolset(snapshot);
        options.signal?.throwIfAborted();
        if (closed) throw new Error("MCP application closed during startup");

        // Duplicate names silently last-write-wins in several bare-name lookups,
        // so one bag can shadow another's tool with no error. Surface it at boot.
        const duplicates = findDuplicateToolNames(allTools);
        if (duplicates.withinNamespace.length > 0) {
          log.error("tools.duplicate_names", {
            tools: duplicates.withinNamespace,
          });
        }
        if (duplicates.crossNamespace.length > 0) {
          log.warn("tools.duplicate_names_cross_namespace", {
            tools: duplicates.crossNamespace,
          });
        }

        if (mode === "stdio") return startStdio(allTools, resourceRegistrars);
        const pool = await loadBagPool(snapshot, log);
        cleanup.add(() => pool.close());
        // bag_auth and credential_status need live pool access, so they are built after pool creation
        return startHttp(
          httpCtx!,
          [
            ...allTools,
            buildBagAuthTool(pool, snapshot.bags),
            buildCredentialStatusTool(pool, snapshot.bags),
          ],
          pool,
          resourceRegistrars,
        );
      });

    return { close };
  } catch (error) {
    httpCtx?.gate.reject(error);
    await close();
    throw error;
  }
}
