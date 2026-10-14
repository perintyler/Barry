/**
 * Session tool resolution + its short-lived cache, extracted from application.ts.
 *
 * Behaviour is byte-faithful to the inlined version. The only change is shape:
 * the handful of composition-root closures it used (`log`, the identity-env and
 * tool-visibility helpers, the per-invocation store context) are injected via
 * `createSessionToolsResolver`, which returns the same `resolveSessionTools`
 * entry point plus an `invalidate` hook for the refresh path.
 */
import type { Logger } from "@barry-rocks/sdk/logging";
import type { ExecutionContext } from "@barry-rocks/sdk/bounds";
import type { StoreContext } from "@barry-rocks/sdk/stores";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { collectToolMeta } from "@barry-rocks/sdk/internal/tools";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { expandCompositionFromSnapshot } from "@barry-rocks/sdk/internal/bags";
import { checkBagCredentials, type MissingCredential } from "@barry-rocks/sdk/internal/env";
import { assertToolAllowed, qualifyToolId } from "@barry-rocks/sdk/bounds";
import { traits, identityRecords, type IdentityRecord } from "@barry-rocks/identities-bag";
import { getSession } from "@barry-rocks/sessions-bag/client";
import {
  proxiedToolsToMeta,
  addSharedToolsForBag,
  BagConnectionPool,
  mapWithConcurrency,
  type FilterableProxiedTool,
  type BagServerConfig,
} from "./bag-proxy.js";
import {
  applyBoundGuards,
  toToolMeta,
  type RuntimeTool,
} from "./tool-runtime.js";
import { resolveSessionBound, ANONYMOUS_SESSION_ID } from "./session-bound.js";
import {
  isCacheEntryUsable,
  traitKeyOf,
  type CacheEntryStamp,
} from "./session-resolve-cache.js";

/** Result of resolving session tools (scope filtering, credential bags, lazy-connect). */
export interface ResolvedSessionTools {
  sessionTools: RuntimeTool[];
  sessionProxiedTools: FilterableProxiedTool[];
  activePoolKeys: string[];
  resolvedEnv: Record<string, string>;
  missingCredentials: MissingCredential[];
  toolDiscovery?: "provider" | "barry";
  /**
   * Namespaces the session's traits ask for, computed BEFORE any bag connects.
   *
   * Distinct from the namespaces present on the resolved tools: a bag that is
   * unauthorized or failed contributes no tools at all, so it vanishes from the
   * tool-derived view while still being something this session wants. Anything
   * reasoning about bags a session needs but cannot currently use has to start
   * here.
   */
  requestedNamespaces: string[];
  /**
   * The identity's bags, composition expanded — bag REGISTRY names, unlike
   * `requestedNamespaces` above. Undefined for an anonymous session, which
   * catalog tools read as "scope unknown" rather than "scope is empty".
   *
   * This is the bag set the session's prompt was built from, so a tool that
   * lists instructions or actions agrees with the pointers already in context.
   */
  identityBagNames?: string[];
}

export interface SessionToolsResolverDeps {
  log: Logger;
  /** Read an identity's resolved environment (vault + file + inline + keychain). */
  resolveIdentityCredentials: (
    identityId: number,
  ) => Promise<Record<string, string>>;
  /** Apply the identity's per-bag tool-visibility overrides to the tool set. */
  identityToolVisibility: (
    allTools: RuntimeTool[],
    identity: IdentityRecord,
  ) => Promise<RuntimeTool[]>;
  /** Build the per-invocation store context the bounded handlers run inside. */
  invocationStores: (
    execution: ExecutionContext,
    node: string,
  ) => Promise<StoreContext>;
}

export interface SessionToolsResolver {
  resolveSessionTools: (
    barrySessionId: string,
    allTools: RuntimeTool[],
    pool: BagConnectionPool,
  ) => Promise<ResolvedSessionTools>;
  /** Drop a session's cached resolution (used by the refresh path). */
  invalidate: (barrySessionId: string) => void;
}

export function createSessionToolsResolver(
  deps: SessionToolsResolverDeps,
): SessionToolsResolver {
  const {
    log,
    resolveIdentityCredentials,
    identityToolVisibility,
    invocationStores,
  } = deps;

  /**
   * Resolve the full set of tools available to a Barry session.
   * Handles trait filtering, credential bag connection, lazy-connect retries,
   * and scope guards. Shared by both `/mcp` and `/mcp/ns/:namespace` handlers.
   */
  async function resolveSessionToolsUncached(
    barrySessionId: string,
    allTools: RuntimeTool[],
    pool: BagConnectionPool,
  ): Promise<ResolvedSessionTools> {
    let sessionTools = allTools;
    let sessionProxiedTools: FilterableProxiedTool[] = [...pool.shared];
    let activePoolKeys: string[] = [];
    let resolvedEnv: Record<string, string> = {};
    let missingCredentials: MissingCredential[] = [];

    const session =
      barrySessionId === ANONYMOUS_SESSION_ID
        ? undefined
        : await getSession(barrySessionId);
    const dbTraits = session ? await traits.list() : [];

    const traitNames = session
      ? ["core", ...session.traits.filter((t: string) => t !== "core")]
      : [];
    const neededNamespaces = new Set<string>();
    for (const t of dbTraits) {
      if (traitNames.includes(t.name)) {
        for (const ns of t.namespaces) neededNamespaces.add(ns);
      }
    }

    if (session) {
      const directNs = Array.isArray(session.metadata?.selected_namespaces)
        ? session.metadata.selected_namespaces
        : [];
      for (const ns of directNs) neededNamespaces.add(ns);
    }

    let toolDiscovery: "provider" | "barry" | undefined;
    // Stays undefined without an identity. Catalog tools read its ABSENCE as
    // "scope unknown" and list everything; an empty array would mean "this
    // session has no bags" and hide all prose, which is why this is never
    // defaulted to [].
    let identityBagNames: string[] | undefined;

    if (session?.identity_id) {
      resolvedEnv = await resolveIdentityCredentials(session.identity_id);
      const barry = await identityRecords.row(session.identity_id);
      if (barry) {
        allTools = await identityToolVisibility(allTools, barry);
        sessionTools = allTools;
      }
      if (
        barry?.metadata.tool_discovery === "barry" ||
        barry?.metadata.tool_discovery === "provider"
      ) {
        toolDiscovery = barry.metadata.tool_discovery;
      }
      // The identity's bags, composition expanded — the same set and the same
      // expansion the prompt index was built from (bags/sessions/api session-runtime,
      // cli/src/sdk.ts), so a catalog tool and the pointers already in context
      // agree about what this session has.
      //
      // NOT the trait namespaces resolved above: those are a tool grant, and the
      // two are far apart in practice. Measured against a live identity, trait
      // namespaces scoped its instruction listing to 1 of the 16 its bags ship —
      // it would have hidden svg-craft from a session that enabled the svg bag.
      // Registry names, which is what the catalogs match on.
      if (barry?.metadata.bags?.length) {
        try {
          identityBagNames = await expandCompositionFromSnapshot(
            barry.metadata.bags,
          );
        } catch (error) {
          // Best-effort: a catalog listing everything is a worse prompt, not a
          // broken session. Left undefined so the tools fall back to global.
          log.warn("session.bag_scope_failed", {
            barrySessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      log.info("session.barry_resolved", {
        barrySessionId,
        identityId: session.identity_id,
        envVars: Object.keys(resolvedEnv).length,
        toolDiscovery,
        scopedBags: identityBagNames?.length,
      });
    }

    const neededDeferred: Record<string, BagServerConfig> = {};
    for (const ns of neededNamespaces) {
      if (pool.deferredConfigs[ns])
        neededDeferred[ns] = pool.deferredConfigs[ns];
    }
    missingCredentials = checkBagCredentials(neededDeferred, resolvedEnv);
    if (missingCredentials.length > 0) {
      log.warn("session.missing_credentials", {
        barrySessionId,
        bags: missingCredentials.map((m) => ({
          bag: m.bag,
          missing: m.missingVars,
        })),
      });
    }

    const neededBags = [...neededNamespaces].filter(
      (ns) => pool.deferredConfigs[ns],
    );
    if (neededBags.length > 0) {
      const barryTools = await pool.getToolsForSession(
        neededBags,
        resolvedEnv,
        barrySessionId,
      );
      sessionProxiedTools = barryTools;
      activePoolKeys = pool.getActiveKeys(
        neededBags,
        resolvedEnv,
        barrySessionId,
      );
    }

    // Lazy-connect: retry failed/needs-auth/auth-expired shared bags if needed.
    if (session) {
      const retryPools = {
        ...pool.failedSharedConfigs,
        ...pool.needsAuth,
        ...pool.authExpired,
      };
      const bagsToRetry = [...neededNamespaces]
        .filter((ns) => retryPools[ns])
        .map((ns) => retryPools[ns]);

      if (bagsToRetry.length > 0) {
        log.info("bag_pool.lazy_connect", {
          barrySessionId,
          bags: bagsToRetry.map((p) => p.name),
        });

        // Bound retry fan-out while each connection key retains its own cooldown.
        // Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
        const retryResults = await mapWithConcurrency(
          bagsToRetry,
          5,
          async (c) => ({
            name: c.name,
            tools: await pool.retryConnect(c, resolvedEnv),
          }),
        );

        for (const r of retryResults) {
          if (r.tools) {
            addSharedToolsForBag(pool, r.name, r.tools);
            sessionProxiedTools.push(...r.tools);
            delete pool.failedSharedConfigs[r.name];
            delete pool.needsAuth[r.name];
            delete pool.authExpired[r.name];
            log.info("bag_pool.lazy_connected", {
              bag: r.name,
              tools: r.tools.length,
            });
          }
        }
      }
    }

    // Include proxied tool metadata in the filtering pipeline.
    const runtimeMeta = [
      ...toToolMeta(allTools),
      ...proxiedToolsToMeta(sessionProxiedTools),
    ];
    const runtimeNames = new Set(runtimeMeta.map((t) => qualifyToolId(t.namespace, t.toolName)));
    const registryMeta = (await collectToolMeta()).filter(
      (t) => !runtimeNames.has(qualifyToolId(t.namespace, t.toolName)),
    );
    const allMeta = [...runtimeMeta, ...registryMeta];
    const resolved = await resolveSessionBound(
      barrySessionId,
      allMeta,
      session ? { session, identity: session.identity_id ? installationRegistry().identityId(session.identity_id) : undefined } : undefined,
    );
    // Filter on the QUALIFIED id. Testing `allowedTools.has(t.name)` here was
    // the namespace bypass: authorization decides per (namespace, name), the
    // bare-name set collapses the pair, and every tool sharing an allowed name
    // survived. Granting `system` therefore kept `git`'s `status` — reachable
    // through both the aggregate and namespace-scoped endpoints.
    sessionTools = allTools.filter((t) =>
      resolved.allowedToolIds.has(qualifyToolId(t.namespace, t.name)),
    );
    sessionProxiedTools = sessionProxiedTools.filter((t) =>
      resolved.allowedToolIds.has(qualifyToolId(t.namespace, t.name)),
    );
    if (resolved.bound) {
      sessionTools = applyBoundGuards(sessionTools, resolved.bound);
    }
    const installation = installationRegistry();
    const execution = {
      identity: session?.identity_id
        ? installation.identityId(session.identity_id)
        : undefined,
      traits: resolved.traits ?? session?.traits ?? [],
      harness: resolved.harness,
      bound: resolved.bound,
      allowedToolIds: [...resolved.allowedToolIds],
    };
    sessionTools = sessionTools.map((tool) => {
      const original = tool.handler;
      return {
        ...tool,
        handler: async (params, context) => {
          assertToolAllowed(
            execution,
            { namespace: tool.namespace, toolName: tool.name },
            installation.id,
          );
          return withStoreContext(
            await invocationStores(execution, installation.id),
            () => original(params, context),
          );
        },
      };
    });
    log.info("session.bounded", {
      barrySessionId,
      totalTools: allTools.length + sessionProxiedTools.length,
      filteredNative: sessionTools.length,
      filteredProxied: sessionProxiedTools.length,
    });

    return {
      sessionTools,
      sessionProxiedTools,
      activePoolKeys,
      resolvedEnv,
      missingCredentials,
      toolDiscovery,
      requestedNamespaces: [...neededNamespaces],
      identityBagNames,
    };
  }

  /**
   * Short-lived cache of in-flight/recent session resolutions.
   *
   * A session opens one transport per namespace, and every one of them would
   * otherwise repeat the same session + traits + barry + credential resolution
   * (including bag connects) within milliseconds of each other. Caching the
   * *promise* collapses that burst into a single pass.
   *
   * The TTL is deliberately short: bag state changes mid-session (`bag_auth`,
   * credential expiry) must be picked up on the next initialize.
   *
   * Freshness is not only about time — see `session-resolve-cache.ts`. An entry
   * also carries the traits it was computed from, because `barry start` resolves
   * namespaces BEFORE it writes the session's traits, and the trait-less answer
   * that produced was still young when the agent asked for the real one.
   */
  const sessionResolveCache = new Map<
    string,
    CacheEntryStamp & { promise: Promise<ResolvedSessionTools> }
  >();

  async function resolveSessionTools(
    barrySessionId: string,
    allTools: RuntimeTool[],
    pool: BagConnectionPool,
  ): Promise<ResolvedSessionTools> {
    const now = Date.now();

    // One cheap row read before the cache check. It costs a query per initialize
    // but skips the expensive part (trait resolution, barry lookup, credential
    // resolution, bag connects) on a hit — and it is the only way to notice that
    // the traits changed under a still-young entry.
    const current =
      barrySessionId === ANONYMOUS_SESSION_ID
        ? null
        : await getSession(barrySessionId).catch(() => null);
    const traitKey = traitKeyOf(current?.traits);

    const hit = sessionResolveCache.get(barrySessionId);
    if (isCacheEntryUsable(hit, now, traitKey)) return hit!.promise;
    if (hit && hit.traitKey !== traitKey) {
      log.info("session_resolve.traits_changed", {
        barrySessionId,
        from: hit.traitKey || "(none)",
        to: traitKey || "(none)",
      });
    }

    const promise = resolveSessionToolsUncached(barrySessionId, allTools, pool);
    const entry: CacheEntryStamp & { promise: Promise<ResolvedSessionTools> } =
      {
        at: now,
        settledAt: null,
        traitKey,
        promise,
      };
    sessionResolveCache.set(barrySessionId, entry);

    // Stamp settledAt once the promise resolves, so isCacheEntryUsable's short
    // TTL starts counting from when there IS an answer, not from creation — a
    // resolution that takes longer than SESSION_RESOLVE_TTL_MS to settle (DB
    // lookups, credential resolution, bag connects) must not have its entry
    // expire while still pending. Only stamps if this is
    // still the live entry for the session — a trait change or a newer
    // resolution may have already replaced it in the map.
    promise
      .then(() => {
        if (sessionResolveCache.get(barrySessionId) === entry)
          entry.settledAt = Date.now();
      })
      .catch(() => {
        // Never cache a rejection — the next initialize should retry rather than
        // inherit a failure for the rest of the TTL/deadline.
        if (sessionResolveCache.get(barrySessionId) === entry)
          sessionResolveCache.delete(barrySessionId);
      });

    for (const [key, e] of sessionResolveCache) {
      if (!isCacheEntryUsable(e, now, e.traitKey))
        sessionResolveCache.delete(key);
    }

    return promise;
  }

  return {
    resolveSessionTools,
    invalidate: (barrySessionId: string) =>
      void sessionResolveCache.delete(barrySessionId),
  };
}
