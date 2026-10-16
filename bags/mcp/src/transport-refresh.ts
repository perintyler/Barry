/**
 * Live-transport re-scoping: the refresh helper, its resolve-retry self-heal,
 * and the `/refresh-tools` route. Extracted from application.ts verbatim; the
 * shared transport state and composition-root closures are injected via
 * `createTransportRefresh`, which hands back the two helpers the initialize
 * path still calls plus a route registrar.
 */
import express from "express";
import type { Logger } from "@barry-rocks/sdk/logging";
import { getSession } from "@barry-rocks/sessions-bag/client";
import { authorizeSessionExecution } from "@barry-rocks/sessions-bag/execution-authorization";
import { revalidateRequestAuthorization } from "@barry-rocks/sdk/internal/auth";
import { BagConnectionPool, type FilterableProxiedTool } from "./bag-proxy.js";
import {
  resolveToolDiscovery,
  type RuntimeTool,
  type ToolServerHandle,
} from "./tool-runtime.js";
import { scopeToolsForTransport } from "./transport-slots.js";
import { ConnectionLeases } from "./connection-leases.js";
import type { ResolvedSessionTools } from "./session-tools-resolver.js";

export interface TransportRefreshDeps {
  app: express.Express;
  pool: BagConnectionPool;
  allTools: RuntimeTool[];
  log: Logger;
  shutdownHooks: Set<() => Promise<void>>;
  transportOwner: Record<string, string>;
  transportNamespace: Record<string, string>;
  transportSplit: Record<string, Set<string>>;
  toolServers: Record<string, ToolServerHandle>;
  connectionLeases: ConnectionLeases;
  resolveSessionTools: (
    barrySessionId: string,
    allTools: RuntimeTool[],
    pool: BagConnectionPool,
  ) => Promise<ResolvedSessionTools>;
  invalidateSessionResolve: (barrySessionId: string) => void;
  wrapForServing: (
    tools: RuntimeTool[],
    proxiedTools: FilterableProxiedTool[],
    resolvedEnv: Record<string, string>,
    barrySessionId: string | null,
    opts: { advertiseCallable: boolean; bagNames?: string[] },
  ) => RuntimeTool[];
}

export interface TransportRefresh {
  refreshSessionTransports: (
    barrySessionId: string,
    authorize?: () => Promise<void>,
  ) => Promise<{ transports: number; changed: number }>;
  scheduleResolveRetry: (barrySessionId: string, attempt?: number) => void;
}

export function createTransportRefresh(
  deps: TransportRefreshDeps,
): TransportRefresh {
  const {
    app,
    pool,
    allTools,
    log,
    shutdownHooks,
    transportOwner,
    transportNamespace,
    transportSplit,
    toolServers,
    connectionLeases,
    resolveSessionTools,
    invalidateSessionResolve,
    wrapForServing,
  } = deps;

  /**
   * Re-scope every live transport of one agent session from the DB and tell
   * connected clients whose visible list changed.
   *
   * This is the missing link between "bag enabled in the DB" and "running
   * session can use it": nothing else ever re-reads a session's selection after a
   * transport initializes — tools/list answered from init-time state forever.
   * Returns counts so the caller can tell "nothing owned" from "refreshed but
   * identical" from "tools actually changed"; a refresh that cannot report the
   * difference would be unverifiable.
   */
  async function refreshSessionTransports(
    barrySessionId: string,
    authorize?: () => Promise<void>,
  ): Promise<{ transports: number; changed: number }> {
    await authorize?.();
    // The resolve cache stamps entries with session bags and bounds, which a bag_auth
    // does not touch — a young entry would serve the pre-change answer. Drop it.
    invalidateSessionResolve(barrySessionId);

    const sids = Object.entries(transportOwner)
      .filter(([, owner]) => owner === barrySessionId)
      .map(([sid]) => sid);
    if (sids.length === 0) return { transports: 0, changed: 0 };

    const result = await resolveSessionTools(barrySessionId, allTools, pool);
    let changed = 0;
    for (const sid of sids) {
      const handle = toolServers[sid];
      if (!handle) continue;
      const ns = transportNamespace[sid];
      const split = transportSplit[sid] ?? new Set<string>();
      // Same rule as the initialize path: in barry mode the aggregate keeps
      // split namespaces' DEFERRED tools, because it is the only transport that
      // can hold a global tool_search/call_tool deferred list. Omitting it here would
      // hand the aggregate a deferred list at initialize and strip it on the first
      // refresh — a session that started able to reach deferred tools would
      // quietly stop being able to.
      // Through the resolver, not `=== "barry"` on a possibly-undefined value:
      // `toolDiscovery` is undefined when no identity chose one, and comparing
      // that to "barry" silently answers false — which would strip the deferred
      // list while tools/list (which DOES apply the default) hides those same
      // tools, leaving them reachable by neither route.
      const keepDeferred =
        resolveToolDiscovery(result.toolDiscovery) === "barry";
      const nextProxied = scopeToolsForTransport(
        ns,
        split,
        result.sessionProxiedTools,
        keepDeferred,
      );
      let nextTools = scopeToolsForTransport(
        ns,
        split,
        result.sessionTools,
        keepDeferred,
      );
      nextTools = wrapForServing(
        nextTools,
        nextProxied,
        result.resolvedEnv,
        barrySessionId,
        {
          advertiseCallable: !ns,
          bagNames: result.identityBagNames,
        },
      );

      await authorize?.();
      const didChange = handle.refreshTools({
        tools: nextTools,
        proxiedTools: nextProxied,
        bound: result.bound,
      });
      // Resolution can connect a newly packed bag or stop using a removed
      // one. Keep cleanup's ownership view in lockstep with the tools this
      // transport now serves, or the next prune can disconnect a live bag (or
      // retain a removed one) using the leases recorded at initialize time.
      connectionLeases.commit(sid, result.activePoolKeys);
      if (didChange) {
        changed++;
        try {
          // No-op for clients without an open stream; those pick the change up
          // on their next initialize instead.
          await handle.server.server.sendToolListChanged();
        } catch (error) {
          log.warn("refresh.notify_failed", {
            mcpSessionId: sid,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      log.info("refresh.transport", {
        barrySessionId,
        mcpSessionId: sid,
        namespace: ns || "(aggregate)",
        changed: didChange,
        visibleTools: handle.visibleToolNames().length,
      });
    }
    return { transports: sids.length, changed };
  }

  /**
   * Self-heal a transport that initialized while resolution was failing.
   *
   * A resolve error at initialize serves NO tools (fail closed) — but a
   * session must not stay toolless after a transient store/DB blip, so this
   * retries on a backoff and pushes the recovered toolset to the live
   * transport. Clients honoring tools/list_changed update in place; others
   * recover on reconnect. Stops when the transport is gone or attempts run
   * out — and says so, because a retry loop that gives up silently would be
   * indistinguishable from one that never ran.
   */
  const RESOLVE_RETRY_DELAYS_MS = [5_000, 20_000, 60_000];
  const pendingResolveRetries = new Set<string>();
  function scheduleResolveRetry(barrySessionId: string, attempt = 0): void {
    if (attempt === 0) {
      if (pendingResolveRetries.has(barrySessionId)) return;
      pendingResolveRetries.add(barrySessionId);
    }
    if (attempt >= RESOLVE_RETRY_DELAYS_MS.length) {
      pendingResolveRetries.delete(barrySessionId);
      log.warn("resolve_retry.exhausted", {
        barrySessionId,
        attempts: attempt,
      });
      return;
    }
    const timer = setTimeout(async () => {
      // Client gave up or was superseded — nothing left to heal.
      if (!Object.values(transportOwner).includes(barrySessionId)) {
        pendingResolveRetries.delete(barrySessionId);
        return;
      }
      try {
        const result = await refreshSessionTransports(barrySessionId);
        pendingResolveRetries.delete(barrySessionId);
        log.info("resolve_retry.healed", {
          barrySessionId,
          attempt,
          ...result,
        });
      } catch (error) {
        log.warn("resolve_retry.attempt_failed", {
          barrySessionId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        scheduleResolveRetry(barrySessionId, attempt + 1);
      }
    }, RESOLVE_RETRY_DELAYS_MS[attempt]);
    timer.unref();
    shutdownHooks.add(async () => {
      clearTimeout(timer);
    });
  }

  /**
   * Re-scope live sessions after a session selection or auth change (`session.update({ bounds })`,
   * `bag_auth`). Body: `{sessionId}` for one session, `{identityId}` for every live
   * session of that barry, `{}` for every owned session.
   *
   * Called by the API's identity PATCH so a bag enabled in the macOS app
   * reaches running sessions without a reconnect. Counts in the response make
   * "no live sessions", "refreshed but identical", and "tools changed"
   * distinguishable — this endpoint must never be able to fail invisibly.
   */
  app.post("/refresh-tools", express.json(), async (req, res) => {
    const sessionId =
      typeof req.body?.sessionId === "string"
        ? req.body.sessionId
        : undefined;
    const identityId =
      typeof req.body?.identityId === "string"
        ? req.body.identityId
        : undefined;

    if ((req.body?.sessionId !== undefined && (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)))
      || (req.body?.identityId !== undefined && (!identityId || !/^[1-9][0-9]*$/.test(identityId) || !Number.isSafeInteger(Number(identityId))))) {
      return res.status(400).json({ ok: false, error: "invalid refresh selection" });
    }
    const principal = req.authPrincipal;
    if (!principal) return res.status(403).json({ ok: false, error: "Forbidden" });
    try {
      if (!await revalidateRequestAuthorization(req)) throw new Error("Authorization unavailable");
      await authorizeSessionExecution(principal, { sessionId, identityId: identityId ? Number(identityId) : undefined });
    } catch { return res.status(403).json({ ok: false, error: "Forbidden" }); }

    let forbidden = false;
    try {
      let owners = sessionId
        ? [sessionId]
        : [...new Set(Object.values(transportOwner))];
      if (identityId && !sessionId) {
        const matched: string[] = [];
        for (const owner of owners) {
          const session = await getSession(owner).catch(() => null);
          // identity_id is numeric in the DB while the request carries a
          // string; compare normalized or this filter can never match — an
          // always-empty result would be indistinguishable from "no sessions".
          if (
            session &&
            session.identity_id != null &&
            String(session.identity_id) === identityId
          ) {
            matched.push(owner);
          }
        }
        owners = matched;
      }

      const sessions: Record<
        string,
        { transports: number; changed: number }
      > = {};
      for (const owner of owners) {
        try { await authorizeSessionExecution(principal, { sessionId: owner }); }
        catch { continue; }
        sessions[owner] = await refreshSessionTransports(owner, async () => {
          try {
            if (!await revalidateRequestAuthorization(req)) throw new Error("Authorization unavailable");
            await authorizeSessionExecution(principal, { sessionId: owner });
          } catch { forbidden = true; throw new Error("Authorization unavailable"); }
        });
      }
      log.info("refresh.request", { sessionId, identityId, sessions });
      res.json({ ok: true, sessions });
    } catch (error) {
      if (forbidden) return res.status(403).json({ ok: false, error: "Forbidden" });
      const message = error instanceof Error ? error.message : String(error);
      log.error("refresh.error", { error: message });
      res.status(500).json({ ok: false, error: message });
    }
  });

  return { refreshSessionTransports, scheduleResolveRetry };
}
