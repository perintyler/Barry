/**
 * Read/retry control routes for the bag pool and a session's resolved
 * namespaces, extracted from application.ts. Behaviour is byte-faithful; the
 * composition-root values they read (`pool`, the full tool set, the session
 * resolver, the logger) are passed in via `registerControlRoutes`.
 */
import express from "express";
import type { Logger } from "@barry-rocks/sdk/logging";
import { collectToolDefinitions } from "@barry-rocks/sdk/internal/tools";
import { getSession } from "@barry-rocks/sessions-bag/client";
import { makeBagReachFilter } from "./bag-status.js";
import {
  connectBagProxy,
  enrichProxiedTools,
  addSharedToolsForBag,
  BagConnectionPool,
} from "./bag-proxy.js";
import { type RuntimeTool } from "./tool-runtime.js";
import type { ResolvedSessionTools } from "./session-tools-resolver.js";

export interface ControlRoutesDeps {
  app: express.Express;
  pool: BagConnectionPool;
  allTools: RuntimeTool[];
  resolveSessionTools: (
    barrySessionId: string,
    allTools: RuntimeTool[],
    pool: BagConnectionPool,
  ) => Promise<ResolvedSessionTools>;
  log: Logger;
}

export function registerControlRoutes(deps: ControlRoutesDeps): void {
  const { app, pool, allTools, resolveSessionTools, log } = deps;

  /**
   * Namespaces a session actually resolves to.
   *
   * Config builders (CLI + API) call this to decide which `/mcp/ns/<ns>` entries
   * to write. They must not derive the list from session bags alone: the real tool set
   * also depends on `metadata.selected_namespaces`, the barry, and bound
   * filtering — deriving it client-side under-reports and silently collapses
   * tools back onto the `barry` prefix.
   */
  app.get("/session-namespaces", async (req, res) => {
    const barrySessionId = req.query.sessionId;
    if (typeof barrySessionId !== "string" || !barrySessionId) {
      res.status(400).json({ ok: false, error: "Missing sessionId" });
      return;
    }

    try {
      const result = await resolveSessionTools(
        barrySessionId,
        allTools,
        pool,
      );
      const namespaces = new Set<string>();
      for (const t of result.sessionTools)
        if (t.namespace) namespaces.add(t.namespace);
      for (const t of result.sessionProxiedTools)
        if (t.namespace) namespaces.add(t.namespace);
      res.json({ ok: true, namespaces: [...namespaces].sort() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("session_namespaces.error", {
        barrySessionId,
        error: message,
      });
      res.status(500).json({ ok: false, error: message });
    }
  });

  /**
   * Bag health for the pool, optionally narrowed to one session.
   *
   * The pool is process-wide, so an unscoped answer lists bags no particular
   * session can reach. `?sessionId=` narrows every list to the namespaces that
   * session actually resolves to — the same set `/session-namespaces` reports,
   * because installing a bag is not packing it (see session-bound.ts).
   *
   * Scoping is best-effort by design: if the session cannot be resolved, this
   * returns the unscoped pool with `scoped: false` rather than an empty result.
   * A silent narrowing to nothing would read exactly like a healthy pool.
   *
   * Membership is checked three ways, because no single view covers every bag.
   * A bag is kept if the session's tools name it, if its namespace appears on
   * those tools, OR if the session's active bags requested that namespace. The third
   * is load-bearing: an unauthorized or failed bag serves no tools at all, so a
   * purely tool-derived filter drops exactly the bags worth reporting — which is
   * how scoped `needsAuth` once came back empty for a session whose sole packed bag
   * named an unauthorized bag.
   */
  app.get("/bag-status", async (req, res) => {
    const deferred = Object.entries(pool.deferredConfigs).map(
      ([name, config]) => ({
        name,
        requiredVars: config.env ?? [],
      }),
    );

    const status = {
      shared: [...pool.connectedSharedBags],
      needsAuth: Object.keys(pool.needsAuth),
      authExpired: Object.keys(pool.authExpired),
      failed: Object.keys(pool.failedSharedConfigs),
      deferred,
    };

    const barrySessionId = req.query.sessionId;
    if (typeof barrySessionId !== "string" || !barrySessionId) {
      res.json({ ...status, scoped: false });
      return;
    }

    try {
      // An unknown session id must not resolve to an empty tool set and be
      // reported as a narrowed all-clear: resolveSessionTools tolerates a
      // missing row (it returns the default tool set rather than throwing), so
      // without this check a typo'd or expired id answered `scoped: true,
      // needsAuth: []` — the most confident possible way to say nothing is
      // wrong about a session that does not exist.
      const session = await getSession(barrySessionId).catch(() => null);
      if (!session) {
        log.warn("bag_status.unknown_session", { barrySessionId });
        res.json({ ...status, scoped: false, scopeError: "unknown session" });
        return;
      }

      const result = await resolveSessionTools(
        barrySessionId,
        allTools,
        pool,
      );

      // Map bag name -> namespace from the session's own tools. A bag's
      // namespace is NOT its registry key: `datadog-mcp` serves the `datadog`
      // namespace, so comparing keys against namespaces silently matched
      // nothing and reported a narrowed all-clear for every `<service>-mcp`
      // bag. The proxied tools carry both, which is the only authoritative
      // pairing available here.
      const activeBags = new Set<string>();
      for (const t of result.sessionProxiedTools)
        if (t.bag) activeBags.add(t.bag);

      // Local (non-proxied) tools have no bag, so fall back to namespace
      // identity for registry entries whose key IS their namespace.
      const activeNamespaces = new Set<string>();
      for (const t of result.sessionTools)
        if (t.namespace) activeNamespaces.add(t.namespace);

      const reaches = makeBagReachFilter({
        bags: activeBags,
        namespaces: activeNamespaces,
        requested: result.requestedNamespaces,
      });
      const keep = (names: string[]) => names.filter(reaches);
      res.json({
        scoped: true,
        shared: keep(status.shared),
        needsAuth: keep(status.needsAuth),
        authExpired: keep(status.authExpired),
        failed: keep(status.failed),
        deferred: status.deferred.filter((d) => reaches(d.name)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("bag_status.scope_failed", { barrySessionId, error: message });
      res.json({ ...status, scoped: false, scopeError: message });
    }
  });

  // Retry a single bag — attempts reconnection and moves it out of failed/needsAuth/authExpired
  app.post("/bag-retry", express.json(), async (req, res) => {
    const bagName = req.body?.bag;
    if (!bagName || typeof bagName !== "string") {
      res.status(400).json({ ok: false, error: "Missing bag name" });
      return;
    }

    const config =
      pool.authExpired[bagName] ??
      pool.needsAuth[bagName] ??
      pool.failedSharedConfigs[bagName] ??
      pool.originalConfigs[bagName];

    if (!config) {
      res
        .status(404)
        .json({ ok: false, error: `Bag "${bagName}" not found` });
      return;
    }

    try {
      const proxy = await connectBagProxy(config);
      if (!proxy) {
        res.json({ ok: false, error: `Failed to connect to "${bagName}"` });
        return;
      }

      const registry = await collectToolDefinitions();
      const newTools = enrichProxiedTools(
        [proxy],
        registry,
        pool.deferredBagNames,
      );
      addSharedToolsForBag(pool, bagName, newTools);
      delete pool.failedSharedConfigs[bagName];
      delete pool.needsAuth[bagName];
      delete pool.authExpired[bagName];

      log.info("bag_pool.retry_success", {
        bag: bagName,
        tools: proxy.tools.length,
      });
      res.json({ ok: true, tools: proxy.tools.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("bag_pool.retry_failed", { bag: bagName, error: message });
      res.json({ ok: false, error: message });
    }
  });
}
