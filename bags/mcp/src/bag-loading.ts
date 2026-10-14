/**
 * Startup-time bag loading, extracted verbatim from application.ts so the
 * composition root stays readable. Behaviour is byte-faithful to the inlined
 * versions; the only change is that `log` and the shared `bagToolDefinitions`
 * map are passed in rather than closed over.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "@barry-rocks/sdk/logging";
import { applyToolVisibility, collectToolMeta } from "@barry-rocks/sdk/internal/tools";
import {
  checkBagRequirements,
  checkBagDependencyStates,
  DEPENDENCY_SEARCH_DIRS,
  ensureBagsBuilt,
  getBuiltBagEntry,
  collectDeclaredMcpServers,
  findServerKeyConflicts,
  findEndpointDuplicates,
  findDanglingTraitNamespaces,
} from "@barry-rocks/sdk/internal/bags";
import { resolveBagAccess } from "@barry-rocks/sdk/bags";
import type { BagRegistrySnapshot, Bag } from "@barry-rocks/sdk/bags";
import {
  enrichProxiedTools,
  connectBagProxy,
  BagConnectionPool,
  mapWithConcurrency,
  type ConnectedBagProxy,
  type BagServerConfig,
} from "./bag-proxy.js";
import { authenticateBag } from "./bag-auth.js";
import { toToolList, type RuntimeTool } from "./tool-runtime.js";

/**
 * A bag-contributed MCP resource registration (the bag entry module's
 * `registerMcpResources` export, from @barry/tools/mcp-adapter). Replayed onto
 * each per-connection McpServer that serves the bag's namespace, with the
 * session's resolved secrets bound into the context.
 */
export interface BagResourceRegistrar {
  bag: string;
  namespace: string;
  secrets: string[];
  register: (
    server: McpServer,
    context: { secrets: Record<string, string>; sessionId?: string },
  ) => void;
}

export interface LoadedToolset {
  tools: RuntimeTool[];
  resourceRegistrars: BagResourceRegistrar[];
}

/**
 * Dynamically import tool definitions from local bags that declare `tools.entry`.
 * Returns them as runtime tools to merge into the main tool set.
 */
export async function loadBagTools(
  snapshot: BagRegistrySnapshot,
  log: Logger,
  bagToolDefinitions: Map<string, RuntimeTool[]>,
): Promise<LoadedToolset> {
  const tools: RuntimeTool[] = [];
  bagToolDefinitions.clear();
  const resourceRegistrars: BagResourceRegistrar[] = [];

  // Bags are bundled to plain JS ahead of time. The build directory is a cache
  // and may be purged, so rebuild anything missing or stale before loading —
  // otherwise a purge would silently drop every bag's tools.
  if (process.env.BARRY_BAGS_BUILT !== "0") {
    try {
      const results = await ensureBagsBuilt();
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        log.error("bag.build_failed", {
          count: failed.length,
          bags: failed.map((r) => ({ bag: r.name, error: r.error })),
        });
      }
    } catch (error) {
      log.error("bag.build_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let expected = 0;
  let loaded = 0;
  const failures: string[] = [];
  const loadedBags: string[] = [];

  for (const bag of snapshot.bags) {
    if (bag.source.type !== "local" || !bag.manifest?.toolsEntry?.entry)
      continue;
    const resolved = bag.source.path.replace(/^~/, process.env.HOME || "");
    expected++;

    // Capability requirements gate the whole bag: unmet + non-optional means
    // the tools would fail confusingly at call time, so drop them at load with
    // one clear line instead. Checked once here, never per tool call.
    const unmetRequirements = checkBagRequirements(bag);
    const hardUnmet = unmetRequirements.filter((m) => !m.optional);
    for (const m of unmetRequirements.filter((r) => r.optional)) {
      log.warn("bag.requirement_unmet_optional", {
        bag: bag.name,
        message: m.message,
      });
    }
    if (hardUnmet.length > 0) {
      for (const m of hardUnmet) {
        log.error("bag.requirements_unmet", {
          bag: bag.name,
          message: m.message,
        });
      }
      failures.push(bag.name);
      continue;
    }

    // Host binaries warn but do NOT gate, unlike the requirements above.
    //
    // A missing binary breaks one tool at call time with an error the tool
    // itself can explain; dropping the whole bag would trade that for tools
    // that silently do not exist. This line is here so the problem is visible
    // at startup rather than only to whoever calls the tool next.
    //
    // Reachability is asked of THIS process's PATH, because this is the
    // process that will run them. "Is it installed at all" has to be asked
    // somewhere wider, or the two questions collapse: passing our own PATH as
    // both reports a binary sitting in ~/.local/bin as missing, and tells the
    // reader to reinstall something already on disk — the exact wrong advice
    // this check exists to stop giving.
    const installSearch = {
      PATH: [process.env.PATH ?? "", ...DEPENDENCY_SEARCH_DIRS].join(":"),
    };
    for (const status of checkBagDependencyStates(
      bag,
      process.env.PATH ?? null,
      installSearch,
    )) {
      if (status.state === "ok") continue;
      log.warn("bag.dependency_unreachable", {
        bag: bag.name,
        binary: status.dependency.name,
        state: status.state,
        ...(status.resolvedPath ? { foundAt: status.resolvedPath } : {}),
        ...(status.dependency.install
          ? { install: status.dependency.install }
          : {}),
      });
    }

    try {
      // Built output is authoritative; the raw-TS path remains as an escape
      // hatch (BARRY_BAGS_BUILT=0) and for bags the builder could not handle.
      const builtEntry =
        process.env.BARRY_BAGS_BUILT === "0"
          ? null
          : getBuiltBagEntry(bag.name, resolved);
      const entryFile =
        builtEntry ?? join(resolved, bag.manifest.toolsEntry.entry);
      if (!existsSync(entryFile)) {
        log.error("bag.tools_entry_missing", {
          bag: bag.name,
          entry: entryFile,
        });
        failures.push(bag.name);
        continue;
      }

      const mod = await import(entryFile);
      const definitions = toToolList(mod);
      bagToolDefinitions.set(bag.name, definitions);
      const bagTools = applyToolVisibility(definitions, bag.manifest.toolVisibility ?? {});
      loaded++;
      loadedBags.push(bag.name);

      // A bag whose entry also exports `registerMcpResources` contributes
      // MCP resources (MCP-Apps viewers, byte-serving templates) to every
      // connection that serves its namespace. Duck-detected rather than
      // declared in the manifest so a stale bundled schema cannot reject the
      // whole bag over an unknown field.
      if (
        typeof (mod as Record<string, unknown>).registerMcpResources ===
        "function"
      ) {
        resourceRegistrars.push({
          bag: bag.name,
          namespace: bagTools[0]?.namespace ?? bag.name,
          secrets: [...new Set(definitions.flatMap((tool) => tool.secrets ?? []))],
          register: (mod as Record<string, unknown>)
            .registerMcpResources as BagResourceRegistrar["register"],
        });
        log.info("bag.resources_registered", { bag: bag.name });
      }

      if (resolveBagAccess(bag.source) === "deferred") {
        for (const tool of bagTools) tool.deferred = true;
      }

      tools.push(...bagTools);

      log.info("bag.tools_loaded", {
        bag: bag.name,
        entry: entryFile,
        toolCount: bagTools.length,
        // Count actual tagged tools so bag-wide `access: deferred` is reflected,
        // not just the manifest's per-name deferred list.
        deferredCount: bagTools.filter((t) => t.deferred).length,
        tools: bagTools.map((t) => t.name),
      });
    } catch (error) {
      // A bag that fails to load disappears from every session, so this is an
      // error rather than a warning — the silent-skip behaviour it replaces is
      // how the temporal and clickhouse bags went missing unnoticed.
      //
      // Missing credentials are the exception: a bag whose env is not
      // configured on this machine is expected to sit out, so it warns and is
      // not counted as degraded.
      const message = error instanceof Error ? error.message : String(error);
      const missingConfig =
        /not set|not configured|missing .*(key|token|secret|credential)/i.test(
          message,
        );

      if (missingConfig) {
        log.warn("bag.tools_unconfigured", {
          bag: bag.name,
          reason: message,
        });
      } else {
        log.error("bag.tools_import_failed", {
          bag: bag.name,
          error: message,
          stack: error instanceof Error ? error.stack : undefined,
        });
        failures.push(bag.name);
      }
    }
  }

  // Summary line so a silent drop shows up as a count mismatch even when the
  // per-bag errors scroll past.
  if (failures.length > 0) {
    log.error("bag.tools_degraded", {
      bagsExpected: expected,
      bagsLoaded: loaded,
      bagsFailed: failures.length,
      failed: failures,
    });
  } else {
    // Names, not just counts. Tool count is the signal a bag silently stopped
    // loading, but a bare number cannot distinguish "a bag broke" from "the
    // registry changed" — diagnosing a 310 -> 303 drift meant diffing two boots
    // out of the log. With the roster here, one line answers it.
    log.info("bag.tools_summary", {
      bagsExpected: expected,
      bagsLoaded: loaded,
      toolCount: tools.length,
      bags: loadedBags.sort(),
    });
  }

  return { tools, resourceRegistrars };
}

/** Load bag configs from YAML (pure config, no network) */
export function loadBagConfigs(
  snapshot: BagRegistrySnapshot,
  log: Logger,
): Record<string, BagServerConfig> {
  const configs: Record<string, BagServerConfig> = {};

  // One bag owns each server key (sdk/src/bags/mcp-server-conflicts.ts).
  // Violations are logged but never fatal — a config fight between two bags
  // must not take down every other bag's tools. Doctor is the fix surface.
  const declared = collectDeclaredMcpServers(snapshot.bags);
  for (const conflict of findServerKeyConflicts(declared)) {
    log.error("bag_configs.server_key_conflict", {
      key: conflict.key,
      claimants: conflict.claimants,
      identical: conflict.identical,
      message: conflict.message,
    });
  }
  for (const dupe of findEndpointDuplicates(declared)) {
    log.warn("bag_configs.duplicate_endpoint", {
      endpoint: dupe.endpoint,
      claimants: dupe.claimants,
      message: dupe.message,
    });
  }
  for (const dangling of findDanglingTraitNamespaces(snapshot.bags)) {
    log.warn("bag_configs.dangling_trait_namespace", {
      bag: dangling.bag,
      trait: dangling.trait,
      namespace: dangling.namespace,
      message: dangling.message,
    });
  }

  for (const bag of snapshot.bags) {
    for (const [name, server] of Object.entries(bag.mcpServers)) {
      // First declaration wins — deterministic within a snapshot, and the
      // conflict was already logged above (previously: silent last-wins,
      // where the winner depended on registry iteration order).
      if (name in configs) continue;
      // Pull the install hint from the bag's declared dependencies so a
      // missing launcher binary logs actionable guidance instead of a timeout.
      const dep = server.command
        ? bag.dependencies.find((d) => d.name === server.command)
        : undefined;
      configs[name] = {
        name,
        url: server.url,
        command: server.command,
        args: server.args,
        env: server.env,
        ...(server.sessionScoped ? { sessionScoped: true } : {}),
        ...(dep?.install ? { installHint: dep.install } : {}),
      };
    }
  }

  return configs;
}

/** URL-only bag pointing to an external service — likely needs OAuth */
export function isOAuthBagConfig(config: BagServerConfig): boolean {
  if (config.env?.length) return false;
  if (!config.url) return false;
  try {
    const parsed = new URL(config.url);
    return parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Load bag configs and build a BagConnectionPool.
 *
 * Credentialless bags (no `config.env`) are connected eagerly at startup.
 * Credential bags are deferred — connected per-barry at session init.
 */
export async function loadBagPool(
  snapshot: BagRegistrySnapshot,
  log: Logger,
): Promise<BagConnectionPool> {
  const registry = await collectToolMeta(snapshot);
  const pool = new BagConnectionPool(registry);

  // Bags the user marked `access: deferred` in the registry — their proxied
  // tools get stamped `deferred` so they leave tools/list but stay searchable.
  pool.deferredBagNames = new Set(
    snapshot.bags
      .filter((p) => resolveBagAccess(p.source) === "deferred")
      .map((p) => p.name),
  );

  try {
    const bagConfigs = loadBagConfigs(snapshot, log);

    // Store all configs so authExpired bags can be recovered later
    pool.originalConfigs = { ...bagConfigs };

    // Split bags into credentialless (eager) vs credential/session (deferred).
    //
    // Session-scoped bags join the deferred set even without credentials:
    // connecting them eagerly would put one shared connection in `pool.shared`
    // for every session to drive, which is the exact state-bleed they opt out
    // of. Deferred bags connect per session through getToolsForSession.
    const eagerConfigs: BagServerConfig[] = [];
    for (const config of Object.values(bagConfigs)) {
      if (config.env?.length || config.sessionScoped) {
        pool.deferredConfigs[config.name] = config;
      } else {
        eagerConfigs.push(config);
      }
    }

    // Bound eager credentialless connections to avoid simultaneous process and network bursts.
    // Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
    const results = await mapWithConcurrency(
      eagerConfigs,
      5,
      async (config) => ({
        config,
        proxy: await connectBagProxy(config),
      }),
    );

    const proxies: ConnectedBagProxy[] = [];
    for (const r of results) {
      if (r.proxy) {
        proxies.push(r.proxy);
      } else if (isOAuthBagConfig(r.config)) {
        pool.needsAuth[r.config.name] = r.config;
        log.warn("bag_pool.needs_auth", {
          bag: r.config.name,
          url: r.config.url,
          hint: `Run: barry bag auth ${r.config.name}`,
        });
      } else {
        pool.failedSharedConfigs[r.config.name] = r.config;
      }
    }

    pool.shared = enrichProxiedTools(
      proxies,
      registry,
      pool.deferredBagNames,
    );
    for (const p of proxies) pool.connectedSharedBags.add(p.name);

    log.info("bag_pool.ready", {
      shared: [...pool.connectedSharedBags],
      deferred: Object.keys(pool.deferredConfigs),
      needsAuth: Object.keys(pool.needsAuth),
      failed: Object.keys(pool.failedSharedConfigs),
      sharedTools: pool.shared.length,
    });
  } catch (error) {
    log.warn("bag_pool.load_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return pool;
}

/**
 * Build the `bag_auth` tool. Defined inline (not in @barry/tools) because it
 * must mutate live server state — the BagConnectionPool — which static tool
 * modules can't reach.
 */
export function buildBagAuthTool(
  pool: BagConnectionPool,
  bags: readonly Bag[],
): RuntimeTool {
  return {
    namespace: "barry",
    access: "write",
    name: "bag_auth",
    description:
      "Authorize a bag whose token is missing or expired. For OAuth bags (Notion, Sentry, …) this opens a browser tab and waits for the user to authorize. For CLI-delegated bags (Temporal, …) this runs the vendor CLI's login command. Call this when a bag tool returns an authentication error or a bag is reported as needing authorization, then retry the original tool call.",
    schema: {
      bag: z
        .string()
        .describe('Bag name to authorize (e.g. "notion", "temporal")'),
    },
    handler: async (params: Record<string, unknown>) => {
      const { bag } = z.object({ bag: z.string() }).parse(params);
      return authenticateBag(pool, bag, bags);
    },
  };
}

/**
 * Build the `credential_status` tool. Reports which bags are missing API keys
 * or CLI-delegated auth so the agent can tell the user exactly what to fix.
 */
export function buildCredentialStatusTool(
  pool: BagConnectionPool,
  bags: readonly Bag[],
): RuntimeTool {
  return {
    namespace: "barry",
    access: "read",
    name: "credential_status",
    deferred: true,
    description:
      "Check which bags are missing credentials — API keys, OAuth tokens, or CLI-delegated auth. Use this when tools seem to be missing or a bag fails to connect.",
    schema: {},
    handler: async () => {
      const deferred = Object.keys(pool.deferredConfigs);
      const needsAuth = Object.keys(pool.needsAuth);
      const authExpired = Object.keys(pool.authExpired);

      const deferredDetails = deferred.map((name) => {
        const config = pool.deferredConfigs[name];
        return {
          bag: name,
          requiredVars: config.env ?? [],
          status: "deferred" as const,
        };
      });

      const cliAuthDetails: Array<{
        bag: string;
        authenticated: boolean;
        authCommand: string;
      }> = [];
      for (const bag of bags) {
        if (!bag.manifest?.auth?.check) continue;
        const check = bag.manifest.auth.check;
        const authenticated = await new Promise<boolean>((resolve) => {
          execFile(
            check.command,
            check.args ?? [],
            { timeout: 10_000 },
            (err) => resolve(!err),
          );
        });
        cliAuthDetails.push({
          bag: bag.name,
          authenticated,
          authCommand: `barry bag auth ${bag.name}`,
        });
      }

      const needsCliAuth = cliAuthDetails.filter((d) => !d.authenticated);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                deferredBags: deferredDetails,
                needsOAuth: needsAuth,
                authExpired,
                cliDelegatedAuth: cliAuthDetails,
                guidance:
                  deferredDetails.length > 0
                    ? "Deferred bags need API keys added to the user's barry. Ask the user to run: barry vault set-env <VAR_NAME> <value> --source vault"
                    : needsAuth.length > 0
                      ? "OAuth bags need browser authorization. Call the bag_auth tool with the bag name."
                      : needsCliAuth.length > 0
                        ? `CLI-delegated bags need authorization. Call the bag_auth tool with: ${needsCliAuth.map((d) => d.bag).join(", ")}`
                        : "All bag credentials are configured.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}
