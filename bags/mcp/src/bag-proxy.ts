/**
 * Bag proxy integration for the barry MCP server.
 *
 * Bridges @barry-rocks/sdk/bags proxy (client lifecycle, tool discovery) with
 * the McpServer (tool listing, call dispatch). Overrides the underlying
 * Server's request handlers to serve proxied tools alongside native ones
 * with full JSON Schema fidelity.
 */

import { createHash } from "node:crypto";
import { oauthHelperLaunch } from "./oauth-launch.js";
import { createOAuthFetch } from "./oauth-fetch.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  guardToolCall,
  narrowInputSchemaForBound,
  qualifyToolId,
  type Bound,
  type ToolDescriptor,
} from "@barry-rocks/sdk/bounds";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { hasOAuthTokens, getOAuthAccessToken, refreshOAuthToken } from "@barry-rocks/sdk/internal/vault";
import { noSseFetch } from "@barry-rocks/sdk/internal/mcp";
import { isBinaryOnPath } from "@barry-rocks/sdk/internal/bags";
import { createLogger } from "@barry-rocks/sdk/logging";
import { capToolResult, resultCharLimitFromEnv } from "@barry-rocks/sdk/tools";
import { zodSchemaToJson as sharedZodSchemaToJson } from "@barry-rocks/sdk/internal/tools";
import { getRegisteredTools } from "./sdk-internals.js";
import { popPrompts, formatInboxMessage, type PromptRecord } from "@barry-rocks/sessions-bag/client";

/**
 * One queued prompt, phrased for the session reading it.
 *
 * Kept as a named re-export because this module's tests and callers name it;
 * the copy itself now lives with the inbox (sessions bag `delivery/`), so the
 * tool-result path, the runtime relay and the terminal socket all deliver the
 * same sentence. They did not when each surface owned its own wording.
 */
export function queuedPromptNote(p: PromptRecord): string {
  return formatInboxMessage(p);
}

const log = createLogger("bag-proxy", { transport: "stderr" });

const AUTH_STATUS_PATTERNS = [/\b401\b/, /\b403\b/];
// Separators are matched as [\s_-]? so RFC 6749/6750 error codes (`invalid_token`,
// `invalid_grant`) are caught alongside their prose spellings. The underscored
// codes are what upstream servers actually put on the wire — Notion returns
// `{"error":"invalid_token"}` — so a space-only pattern misses the common case.
const AUTH_WORD_PATTERNS = [
  /unauthorized/i,
  /unauthenticated/i,
  /token[\s_-]?expired/i,
  /expired[\s_-]?token/i,
  /access[\s_-]?denied/i,
  /invalid[\s_-]?token/i,
  /invalid[\s_-]?grant/i,
  /invalid[\s_-]?client/i,
  /invalid[\s_-]?api[\s_-]?key/i,
  /token[\s_-]?is[\s_-]?invalid/i,
  /authentication[\s_-]?required/i,
  /refresh[\s_-]?token[\s_-]?failed/i,
];
const TRANSPORT_DEATH_PATTERNS = [
  /transport closed/i,
  /connection closed/i,
  /process exit/i,
  /ECONNREFUSED/,
  /ECONNRESET/,
];

/**
 * Detect whether an error is likely an OAuth/auth failure.
 *
 * For HTTP status codes and auth keywords, always returns true.
 * For transport death patterns (process died, connection dropped), only returns
 * true when `isOAuthBag` is set — credential bags dying is usually a
 * different problem.
 */
export function isAuthError(message: string, isOAuthBag = false): boolean {
  for (const p of AUTH_STATUS_PATTERNS) {
    if (p.test(message)) return true;
  }
  for (const p of AUTH_WORD_PATTERNS) {
    if (p.test(message)) return true;
  }
  if (isOAuthBag) {
    for (const p of TRANSPORT_DEATH_PATTERNS) {
      if (p.test(message)) return true;
    }
  }
  return false;
}

/**
 * Extract the text of a tool result that reported failure in-band.
 *
 * MCP servers signal tool failure two ways: by throwing a JSON-RPC error (which
 * `client.callTool` rejects on) or by RESOLVING with `{ isError: true }`. The SDK
 * only reads `isError` to skip output-schema validation, so the second kind
 * arrives as an ordinary return value. Returns undefined when the result is not
 * an in-band error, so callers can pass successes straight through.
 */
export function inBandErrorText(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const { isError, content } = result as { isError?: unknown; content?: unknown };
  if (isError !== true) return undefined;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const { type, text } = part as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Build a user-facing error message for auth-expired bags.
 *
 * The remedy depends on how the bag authenticates, so `isOAuth` must be the
 * pool's verdict for THIS bag. Pointing a non-OAuth bag at `bag_auth` is a
 * dead end — it answers such bags with "does not use OAuth" — yet that is
 * what happened when the keyless web-fetching bag hit an upstream 401/quota
 * error: agents chased `bag_auth`, and `barry bag auth` correctly refused.
 * A remedy that cannot work is worse than none.
 */
export function authExpiredMessage(bagName: string, originalError?: string, isOAuth = true): string {
  const lines = isOAuth
    ? [
        `The "${bagName}" bag returned an authentication error. Its OAuth token has likely expired.`,
        "",
        `To fix: call the \`bag_auth\` tool with { "bag": "${bagName}" }. It opens one browser tab for the user to authorize, waits for completion, and reconnects the bag — then retry the original tool call.`,
        `(Humans can alternatively run \`barry bag auth ${bagName}\` in a terminal.)`,
      ]
    : [
        `The "${bagName}" bag returned an authentication error. This bag does not use OAuth, so \`bag_auth\` cannot fix it — do not call it.`,
        "",
        `Likely causes: a missing or invalid API key, or an upstream quota/rate limit. To fix: a human sets the bag's credential with \`barry vault set-env <KEY> <value> --source vault|keychain\` (or waits out the quota); the bag reconnects on the next session or MCP server restart.`,
      ];
  if (originalError) {
    lines.push("", `Original error: ${originalError}`);
  }
  return lines.join("\n");
}

/** A tool discovered from a bag MCP server */
export interface ProxiedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  bag: string;
  /** MCP annotations from the upstream server, preserved for access inference and passthrough. */
  annotations?: ToolAnnotations;
}

/** Tool metadata from barry://tools-meta resource */
export interface BagToolMetaEntry {
  name: string;
  namespace: string;
  access: "read" | "write";
}

/** Connected bag with its MCP client and discovered tools */
export interface ConnectedBagProxy {
  name: string;
  client: Client;
  tools: ProxiedTool[];
  /** Metadata from barry://tools-meta, if the bag provides it */
  toolsMeta?: BagToolMetaEntry[];
}

/** Enriched proxied tool with namespace/access metadata for bound filtering */
export interface FilterableProxiedTool extends ProxiedTool {
  namespace: string;
  access: "read" | "write";
  /** Metadata hint — clients may use this to defer tool loading. */
  deferred?: boolean;
  /** Reference to the client for forwarding calls */
  proxy: ConnectedBagProxy;
  /** Optional session bound attached for runtime guard enforcement and schema narrowing. */
  bound?: Bound | null;
  /** Optional pre-bound guard callback invoked before forwarding a call. */
  guard?: (args: Record<string, unknown>) => Promise<void> | void;
  /** Set when an active bag replaced this tool in-place via `implements:`. */
  replaced?: boolean;
}

/**
 * Enrich proxied tools with namespace/access metadata.
 *
 * Resolution order per tool:
 * 1. barry://tools-meta from the bag (self-describing bags via startBagServer)
 * 2. Tool metadata collected from bag registry (collectToolDefinitions)
 * 3. MCP annotations: readOnlyHint → "read", else "write"
 * 4. Default: bag name as namespace, "write" as access (conservative)
 */
export function enrichProxiedTools(
  proxies: ConnectedBagProxy[],
  registry: ToolDescriptor[],
  deferredBags?: Set<string>,
): FilterableProxiedTool[] {
  const registryByName = new Map(registry.map((t) => [t.toolName, t]));
  const enriched: FilterableProxiedTool[] = [];

  for (const proxy of proxies) {
    const bagMetaByName = new Map(
      (proxy.toolsMeta ?? []).map((m) => [m.name, m]),
    );

    for (const tool of proxy.tools) {
      const bagMeta = bagMetaByName.get(tool.name);
      const registryMeta = registryByName.get(tool.name);

      enriched.push({
        ...tool,
        namespace: bagMeta?.namespace ?? registryMeta?.namespace ?? tool.bag,
        access: bagMeta?.access
          ?? (registryMeta?.access as "read" | "write")
          ?? (tool.annotations?.readOnlyHint === true ? "read" : "write"),
        deferred: deferredBags?.has(tool.bag) ?? false,
        proxy,
      });
    }
  }

  return enriched;
}

/**
 * Convert enriched proxied tools to ToolDescriptor for bound filtering.
 */
export function proxiedToolsToMeta(tools: FilterableProxiedTool[]): ToolDescriptor[] {
  return tools.map((t) => ({
    toolName: t.name,
    namespace: t.namespace,
    access: t.access,
    annotations: t.annotations,
  }));
}

/**
 * Patch a McpServer to dispatch tools/call (and default tools/list) to proxied tools.
 *
 * When a pool is provided, tool call errors are checked for auth failures.
 * On auth error, the bag is marked as authExpired and subsequent calls
 * return an instant actionable message without a network round-trip.
 */
export function patchServerWithProxiedTools(
  mcpServer: McpServer,
  proxiedTools: FilterableProxiedTool[],
  pool?: BagConnectionPool,
  opts?: {
    /**
     * Install even with zero proxied tools. A server that starts TOOLLESS
     * needs this handler as its complete tools/call (it dispatches natives
     * too), because the SDK cannot install its own after connect.
     */
    force?: boolean;
    /**
     * The session this connection belongs to, if any. Every tool call for a
     * live session passes through this one handler - proxied and native
     * alike - which makes it the single place to deliver messages queued
     * for a session another caller could not reach directly (see
     * queuePrompt in bags/sessions/api's message route). No new poll loop or
     * hook: the session's own next tool call is the delivery mechanism.
     */
    barrySessionId?: string;
    /**
     * Session Bound (or getter returning the live Bound) enforced on proxied
     * `tools/call` and used to narrow `inputSchema` in `tools/list`.
     */
    bound?: Bound | null | (() => Bound | null | undefined);
    /**
     * Qualified `<namespace>:<name>` tool IDs replaced in-place by an active
     * bag's `implements: { tools: [...] }` declaration. Replaced proxied tools
     * are omitted from `tools/list` and bypassed in `tools/call` so the
     * in-process replacement handles the call instead of being shadowed.
     */
    replacedToolIds?: ReadonlySet<string> | readonly string[];
    /** Override node ID for `bound.nodes` checks (defaults to installation ID). */
    nodeId?: string;
    /**
     * Called once per proxied tool call, with its outcome.
     */
    onToolCall?: (call: { name: string; durationMs: number; ok: boolean; error?: string }) => void;
  },
): void {
  if (proxiedTools.length === 0 && !opts?.force) return;

  const server = mcpServer.server;
  const registeredTools = getRegisteredTools(mcpServer);
  const barrySessionId = opts?.barrySessionId;
  const replacedSet = new Set<string>(
    opts?.replacedToolIds ? [...opts.replacedToolIds] : [],
  );
  const resolveBound = (): Bound | null | undefined =>
    typeof opts?.bound === "function" ? opts.bound() : opts?.bound;
  const isReplaced = (pt: FilterableProxiedTool): boolean =>
    pt.replaced === true ||
    replacedSet.has(qualifyToolId(pt.namespace, pt.name)) ||
    replacedSet.has(pt.name);

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const activeBound = resolveBound();
    return {
      tools: [
        ...Object.entries(registeredTools)
          .filter(([, tool]) => tool.enabled !== false)
          .map(([name, tool]) => ({
            name,
            description: tool.description ?? "",
            inputSchema: narrowInputSchemaForBound(
              zodSchemaToJson(tool.inputSchema, name),
              name,
              activeBound,
            ),
            annotations: tool.annotations,
          })),
        ...proxiedTools
          .filter((pt) => !isReplaced(pt))
          .map((pt) => ({
            name: pt.name,
            description: pt.description,
            inputSchema: narrowInputSchemaForBound(
              pt.inputSchema,
              qualifyToolId(pt.namespace, pt.name),
              activeBound ?? pt.bound,
            ),
            annotations: pt.annotations,
          })),
      ],
    };
  });

  // Override tools/call to dispatch to proxied tools.
  //
  // Lookup scans the live array on every call rather than a Map built here:
  // tool-runtime's refreshTools mutates `proxiedTools` IN PLACE when a bag is
  // enabled mid-session, and a snapshot Map would silently keep dispatching
  // the old set. Counts are small and tools/call is not hot; the linear scan
  // is the price of staying current.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await handleToolCall(request, extra);
    // One delivery point for both branches below (proxied and native): a
    // queued phone message is appended to whatever tool result this call
    // happens to produce, wrapped so it reads as a distinct note rather
    // than the tool's own output.
    if (!barrySessionId) return result;
    const queued = await popPrompts(barrySessionId);
    if (queued.length === 0) return result;
    // CallToolResult has a rare alternate shape ({ toolResult }, no
    // content array) from legacy servers; leave those untouched rather
    // than force a shape onto a result we cannot safely extend. The
    // message stays queued and is retried on the session's next call.
    if (!("content" in result) || !Array.isArray(result.content)) return result;
    const notes = queued.map((p: PromptRecord) => queuedPromptNote(p)).join("\n");
    const isError = "isError" in result ? result.isError : undefined;
    return {
      isError,
      content: [
        ...result.content,
        { type: "text" as const, text: `<queued-message>\n${notes}\n</queued-message>` },
      ],
    };
  });

  async function handleToolCall(request: { params: { name: string; arguments?: Record<string, unknown> } }, extra: unknown): Promise<CallToolResult> {
    const { name, arguments: args } = request.params;
    const proxied = proxiedTools.find((t) => t.name === name && !isReplaced(t));

    if (proxied) {
      if (pool?.authExpired[proxied.bag]) {
        return {
          content: [
            { type: "text" as const, text: authExpiredMessage(proxied.bag, undefined, pool.isBagOAuth(proxied.bag)) },
          ],
          isError: true,
        };
      }

      // Monotonic: `Date.now()` is wall clock, and wall clock advances while
      // the host sleeps. A call straddling a lid-close would report the sleep
      // as its own duration -- the defect that once put a 17.8-minute reading
      // into a 4-second probe.
      const startedAt = performance.now();
      const report = (ok: boolean, error?: string) => {
        try {
          opts?.onToolCall?.({ name, durationMs: performance.now() - startedAt, ok, error });
        } catch {
          /* reporting is best-effort */
        }
      };

      try {
        if (proxied.guard) {
          await proxied.guard(args ?? {});
        }
        const activeBound = resolveBound() ?? proxied.bound ?? null;
        if (activeBound) {
          let fallbackNodeId: string | undefined;
          if (!opts?.nodeId) {
            try {
              fallbackNodeId = installationRegistry().id;
            } catch {
              fallbackNodeId = undefined;
            }
          }
          await guardToolCall(
            {
              id: qualifyToolId(proxied.namespace, proxied.name),
              name: proxied.name,
              namespace: proxied.namespace,
            },
            args ?? {},
            activeBound,
            {
              enforceConfigProtection: true,
              nodeId: opts?.nodeId ?? fallbackNodeId,
            },
          );
        }

        // Prefer the pool's current shared entry for this tool: sessions opened
        // before a re-auth hold stale (disconnected) proxy refs, and the pool
        // has the fresh connection after bag_auth recovery.
        const live =
          pool?.shared.find((t) => t.bag === proxied.bag && t.name === name)?.proxy ??
          proxied.proxy;
        const result = await live.client.callTool({ name, arguments: args ?? {} });

        // An upstream auth failure usually arrives here rather than in the catch:
        // servers report it as a normal result carrying `isError: true`, which
        // `callTool` resolves. Without this check the raw upstream text (e.g.
        // `{"error":"invalid_token"}`) reaches the agent with no hint that
        // `bag_auth` is the remedy, and the bag is never marked auth-expired.
        const inBand = inBandErrorText(result);
        if (pool && inBand !== undefined && isAuthError(inBand, pool.isBagOAuth(proxied.bag))) {
          pool.markAuthExpired(proxied.bag);
          return {
            content: [
              { type: "text" as const, text: authExpiredMessage(proxied.bag, inBand, pool.isBagOAuth(proxied.bag)) },
            ],
            isError: true,
          };
        }

        // Cap at the boundary: proxied bags never pass through registerTools'
        // formatting in THIS process, so this relay is their only size gate.
        // capToolResult<T>(result: T): T loses CallToolResult's own type
        // through its generic bound; the cast restates what result already
        // is, it does not widen what this function actually returns.
          // `isError` is the upstream's own verdict. A proxied bag reporting a
          // failure in-band is still a failure; counting it as success would
          // make every remote bag's error rate read as zero.
          report(result?.isError !== true, inBandErrorText(result));
        return capToolResult(result, resultCharLimitFromEnv()) as CallToolResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
          report(false, message);

        if (pool && isAuthError(message, pool.isBagOAuth(proxied.bag))) {
          pool.markAuthExpired(proxied.bag);
          return {
            content: [
              { type: "text" as const, text: authExpiredMessage(proxied.bag, message, pool.isBagOAuth(proxied.bag)) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }

    // Native tool — call McpServer's registered handler.
    // The SDK's RegisteredTool.handler expects (parsedArgs, extra) when the
    // tool has an inputSchema and (extra) when it doesn't — mirror the SDK's
    // own tools/call dispatch (validateToolInput + executeToolHandler) here,
    // since this override replaces it. Passing the raw request instead of
    // parsed arguments silently breaks every native tool.
    const tool = registeredTools[name];
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      if (tool.inputSchema) {
        // McpServer stores inputSchema as a ZodObject (getZodSchemaObject)
        const parsed = await tool.inputSchema.safeParseAsync(args ?? {});
        if (!parsed.success) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: `Invalid arguments for tool ${name}: ${parsed.error.message}` }),
            }],
            isError: true,
          };
        }
        return await tool.handler(parsed.data, extra);
      }
      return await tool.handler(extra);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  }

  log.info("bag_proxy.patched", {
    nativeCount: Object.keys(registeredTools).length,
    proxiedCount: proxiedTools.length,
  });
}

/**
 * Convert a McpServer-registered tool's Zod schema to JSON Schema.
 *
 * The implementation lives in @barry-rocks/sdk/internal/tools, alongside the
 * validator it round-trips with; this wrapper only binds the server's
 * structured logger so the event names stay `bag_proxy.*` — the dashboards and
 * the war stories in the shared module both refer to them. It takes a
 * structural logger precisely so sdk/ never has to depend on engine.
 */
export function zodSchemaToJson(schema: unknown, toolName?: string): Record<string, unknown> {
  return sharedZodSchemaToJson(schema, toolName, {
    error: (event, meta) => log.error(`bag_proxy.${event}`, meta),
    warn: (event, meta) => log.warn(`bag_proxy.${event}`, meta),
  });
}

export interface BagServerConfig {
  /** Bag name */
  name: string;
  /** HTTP URL for Streamable HTTP transport */
  url?: string;
  /** Command for stdio transport */
  command?: string;
  args?: string[];
  env?: string[];
  /** Working directory for stdio transport */
  cwd?: string;
  /** Install hint shown when the command binary is missing (from bag `dependencies`) */
  installHint?: string;
  /**
   * Give each session its own connection instead of the process-wide one.
   * Set for servers holding live state between calls (a browser tab, a running
   * app), where sharing means one session drives another's artifact.
   */
  sessionScoped?: boolean;
}

export const CONNECT_TIMEOUT_MS = 45_000;
/** How long BagConnectionPool skips retrying a poolKey after a failed connect. */
export const COOLDOWN_MS = 60_000;
/** Protect freshly connected keys through the transport registration window.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */
export const CONNECTION_SETTLE_GRACE_MS = 90_000;

/** Bound concurrency while preserving input order in the result array.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Connect to a bag MCP server, discover its tools, and return a proxy handle.
 *
 * Connection strategies (in order of preference):
 * 1. mcp-remote with --header args → direct HTTP with extracted headers (no npx)
 * 2. command + args (e.g. npx @playwright/mcp) → stdio transport
 * 3. url only → direct HTTP (fails for OAuth-only servers like Sentry/Notion)
 *
 * Times out after 45s to avoid blocking server startup on OAuth prompts.
 */
export async function connectBagProxy(
  config: BagServerConfig,
  resolvedEnv: Record<string, string> = {},
): Promise<ConnectedBagProxy | null> {
  // Fail fast when the launcher binary doesn't exist — otherwise the spawn
  // dies quietly and we burn the full connect timeout before dropping the
  // bag's tools with no user-visible explanation.
  if (config.command && !isBinaryOnPath(config.command)) {
    log.error("bag_proxy.missing_dependency", {
      bag: config.name,
      binary: config.command,
      ...(config.installHint ? { install: config.installHint } : {}),
    });
    return null;
  }

  let timer: ReturnType<typeof setTimeout>;
  // Every Client the inner connect creates is held here so that on timeout or
  // error we can close them — closing kills spawned child processes (e.g.
  // mcp-remote) that would otherwise leak and could still open browser tabs.
  const clients: Client[] = [];
  try {
    const result = await Promise.race([
      connectBagProxyInner(config, resolvedEnv, clients),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          log.warn("bag_proxy.timeout", { bag: config.name });
          resolve(null);
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);
    if (result === null) {
      for (const c of clients) c.close().catch(() => {});
    }
    return result;
  } catch (error) {
    for (const c of clients) c.close().catch(() => {});
    log.error("bag_proxy.connect_failed", {
      bag: config.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Parse --header args from an mcp-remote command and extract the URL.
 * e.g. ["npx", "-y", "mcp-remote", "https://...", "--header", "Authorization: Bearer xxx"]
 * Returns { url, headers } or null if not an mcp-remote command.
 */
function parseMcpRemoteArgs(
  args: string[],
  env: Record<string, string>,
): { url: string; headers: Record<string, string> } | null {
  const remoteIdx = args.indexOf("mcp-remote");
  if (remoteIdx === -1) return null;

  const url = args[remoteIdx + 1];
  if (!url || url.startsWith("-")) return null;

  const headers: Record<string, string> = {};
  for (let i = remoteIdx + 2; i < args.length; i++) {
    if (args[i] === "--header" && args[i + 1]) {
      let headerVal = args[i + 1];
      headerVal = headerVal.replace(/\$\{(\w+)\}/g, (_, name) => env[name] || "");
      const colonIdx = headerVal.indexOf(":");
      if (colonIdx > 0) {
        headers[headerVal.slice(0, colonIdx).trim()] = headerVal.slice(colonIdx + 1).trim();
      }
      i++;
    }
  }

  return { url, headers };
}

async function connectBagProxyInner(
  config: BagServerConfig,
  resolvedEnv: Record<string, string>,
  clients: Client[],
): Promise<ConnectedBagProxy | null> {
  const client = new Client({ name: `barry-proxy-${config.name}`, version: "1.0.0" });
  clients.push(client);
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (config.env) {
    for (const name of config.env) {
      const val = resolvedEnv[name];
      if (val) env[name] = val;
    }
  }

  if (config.command && config.args) {
    // Check if this is an mcp-remote command with --header args.
    // If so, connect directly via HTTP with headers (avoids spawning npx).
    const parsed = parseMcpRemoteArgs(config.args, env);
    if (parsed && Object.keys(parsed.headers).length > 0) {
      await client.connect(new StreamableHTTPClientTransport(new URL(parsed.url), {
        requestInit: { headers: parsed.headers },
        fetch: noSseFetch,
      }));
    } else {
      await client.connect(new StdioClientTransport({
        command: config.command,
        args: config.args,
        env,
        ...(config.cwd ? { cwd: config.cwd } : {}),
      }));
    }
  } else if (config.url) {
    // URL-only bags — try direct HTTP first, then with OAuth token, then mcp-remote
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), {
        fetch: noSseFetch,
      }));
    } catch {
      // Direct HTTP failed (likely needs OAuth). Try with cached Bearer token
      // before falling to the installed OAuth helper process.
      let token = getOAuthAccessToken(config.url);

      // Token expired — try refreshing it before giving up
      if (!token && hasOAuthTokens(config.url)) {
        log.info("bag_proxy.oauth_refreshing", { bag: config.name });
        token = await refreshOAuthToken(config.url);
        if (token) {
          log.info("bag_proxy.oauth_refreshed", { bag: config.name });
        }
      }

      if (token) {
        try {
          const oauthClient = new Client({ name: `barry-proxy-${config.name}`, version: "1.0.0" });
          clients.push(oauthClient);
          await oauthClient.connect(new StreamableHTTPClientTransport(new URL(config.url), {
            fetch: createOAuthFetch(config.url),
          }));
          log.info("bag_proxy.oauth_direct", { bag: config.name });
          return discoverTools(config.name, oauthClient);
        } catch (oauthErr) {
          log.warn("bag_proxy.oauth_direct_failed", {
            bag: config.name,
            error: oauthErr instanceof Error ? oauthErr.message : String(oauthErr),
          });
          // Fall through to mcp-remote
        }
      }

      // No cached tokens — can't connect without browser auth
      if (!hasOAuthTokens(config.url)) {
        log.info("bag_proxy.needs_auth", {
          bag: config.name,
          url: config.url,
          hint: `Authorize via the bag_auth tool or: barry bag auth ${config.name}`,
        });
        return null;
      }

      // Last resort: mcp-remote stdio (handles token refresh, but slow startup)
      const fallbackClient = new Client({ name: `barry-proxy-${config.name}`, version: "1.0.0" });
      clients.push(fallbackClient);
      const launch = oauthHelperLaunch(config.url);
      await fallbackClient.connect(new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        env: launch.env,
      }));
      return discoverTools(config.name, fallbackClient);
    }
  } else {
    return null;
  }

  return discoverTools(config.name, client);
}

async function discoverTools(bagName: string, client: Client): Promise<ConnectedBagProxy> {
  // Some bag servers only expose resources (no tools capability).
  // Gracefully handle "Method not found" (-32601) from listTools.
  let tools: ProxiedTool[] = [];
  try {
    const result = await client.listTools();
    tools = (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? { type: "object" }),
      bag: bagName,
      annotations: t.annotations,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("-32601") || msg.includes("Method not found")) {
      log.debug("bag_proxy.no_tools_capability", { bag: bagName });
    } else {
      throw err;
    }
  }

  // Try reading barry://tools-meta for namespace/access metadata
  let toolsMeta: BagToolMetaEntry[] | undefined;
  try {
    const resource = await client.readResource({ uri: "barry://tools-meta" });
    const content = resource.contents?.[0];
    if (content && "text" in content && typeof content.text === "string") {
      const parsed = JSON.parse(content.text);
      if (Array.isArray(parsed)) {
        toolsMeta = parsed as BagToolMetaEntry[];
      }
    }
  } catch {
    // Resource not available — bag doesn't use startBagServer
  }

  log.info("bag_proxy.connected", {
    bag: bagName,
    tools: tools.length,
    hasToolsMeta: !!toolsMeta,
  });
  return { name: bagName, client, tools, toolsMeta };
}

export async function disconnectBagProxy(proxy: ConnectedBagProxy): Promise<void> {
  try { await proxy.client.close(); } catch { /* already closed */ }
}

// Connection pool — caches bag connections by (bagName, credentialHash)

/**
 * Compute a cache key for a bag connection based on its credential env vars.
 * Bags with no env vars return "shared".
 */
export function credentialHash(config: BagServerConfig, resolvedEnv: Record<string, string>): string {
  if (!config.env?.length) return "shared";
  const pairs = config.env
    .map((name) => `${name}=${resolvedEnv[name] ?? ""}`)
    .sort();
  return createHash("sha256").update(pairs.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Cache key for a bag connection.
 *
 * Normally `bagName:credentialHash`, so sessions sharing a barry reuse one
 * connection. A `sessionScoped` bag adds the session id, giving each session
 * its own server process — the point being that its state (a browser tab, a
 * running app) must not be driven by another session mid-task.
 *
 * Falls back to the shared key when no session id is available; an anonymous
 * caller has no session to scope to, and one shared connection is strictly
 * better than a new process per request.
 *
 * Connections are reclaimed by pruneUnused once no session references the key.
 * A closing transport drops its pool keys immediately, so the next sweep (60s)
 * shuts the server down — verified: a browser process exits within a sweep of
 * the transport closing. The 8h idle TTL only backstops transports that never
 * close cleanly, so a session-scoped server does not idle for hours in the
 * normal case.
 *
 * A client that never closes its transport (a raw curl probe, say) does hold
 * its server process for the full TTL, and repeated probes stack up one
 * process each. That is the TTL working as designed rather than a leak — real
 * clients close — but it is worth knowing when hand-testing.
 */
export function poolKey(
  config: BagServerConfig,
  resolvedEnv: Record<string, string>,
  sessionId?: string,
): string {
  const base = `${config.name}:${credentialHash(config, resolvedEnv)}`;
  return config.sessionScoped && sessionId ? `${base}:session=${sessionId}` : base;
}

/**
 * The cache key `retryConnect`/its cooldown use — `bagName:credentialHash`,
 * no session component (shared bags are never session-scoped). Exported so
 * `bag-auth.ts` can call `pool.clearCooldown()` with the SAME key
 * `retryConnect` will check, rather than re-deriving the formula and risking
 * the two silently drifting apart.
 */
export function retryConnectKey(config: BagServerConfig, resolvedEnv: Record<string, string> = {}): string {
  return `${config.name}:${credentialHash(config, resolvedEnv)}`;
}

interface PoolEntry {
  proxy: ConnectedBagProxy;
  enrichedTools: FilterableProxiedTool[];
}

/**
 * BagConnectionPool manages bag MCP client connections with credential-aware caching.
 *
 * - **shared**: Credentialless bags connected eagerly at startup (playwright, vault, etc.)
 * - **deferredConfigs**: Credential bags deferred until a session provides resolved env vars
 * - **connections**: Cache keyed by `bagName:credentialHash` — reuses connections across
 *   sessions that share the same barry/credentials
 */
export class BagConnectionPool {
  private closed = false;
  async close(): Promise<void> {
    this.closed = true;
    const pending = await Promise.allSettled([...this.pendingConnects.values(), ...this.pendingRetries.values()]);
    const proxies = new Set([...this.connections.values()].map(entry => entry.proxy));
    for (const tool of this.shared) proxies.add(tool.proxy);
    for (const result of pending) if (result.status === "fulfilled" && result.value) for (const tool of result.value) proxies.add(tool.proxy);
    this.connections.clear(); this.shared.length = 0;
    await Promise.allSettled([...proxies].map(proxy => disconnectBagProxy(proxy)));
  }

  /** Tools from credentialless bags, available to all sessions */
  shared: FilterableProxiedTool[] = [];
  /** Names of all connected shared bags (including resource-only bags with 0 tools) */
  connectedSharedBags = new Set<string>();
  /** Bag configs that require credentials — deferred until session init */
  deferredConfigs: Record<string, BagServerConfig> = {};
  /** Failed credentialless bags — retried lazily at session init */
  failedSharedConfigs: Record<string, BagServerConfig> = {};
  /** Bags that failed because they need OAuth authorization */
  needsAuth: Record<string, BagServerConfig> = {};
  /** Bags whose auth expired mid-session (detected via tool call errors) */
  authExpired: Record<string, BagServerConfig> = {};
  /** All bag configs loaded at startup, for recovering authExpired bags */
  originalConfigs: Record<string, BagServerConfig> = {};
  /** Bag names with registry `access: deferred` — their proxied tools are
   * stamped `deferred` as a hint to clients. Populated once at startup. */
  deferredBagNames: Set<string> = new Set();

  private connections = new Map<string, PoolEntry>();
  private registry: ToolDescriptor[];
  /** In-flight cached connects keyed by `bagName:credentialHash` — concurrent session inits share one attempt */
  private pendingConnects = new Map<string, Promise<FilterableProxiedTool[] | null>>();
  /** In-flight uncached retry connects (shared bags) keyed the same way */
  private pendingRetries = new Map<string, Promise<FilterableProxiedTool[] | null>>();
  /** Failed connections keep a per-key retry deadline until recovery or explicit retry.
   * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
   */
  private cooldownUntil = new Map<string, number>();
  /**
   * When each key most recently entered `connections` (ms epoch). Astra
   * review F9-F11: a key becomes prunable the instant it is NOT in the
   * caller-supplied `activeKeys` set passed to `pruneUnused` — but the
   * caller (index.ts) only learns a session references a key once
   * registerTransport() runs, well after resolveSessionTools's DB lookups
   * and this very connect. A freshly-connected key that belongs to a
   * transport still finishing initialization would look unreferenced to any
   * sweep landing in that gap and be closed moments after being opened.
   * `pruneUnused` grants every key a grace period from `connectedAt` before
   * treating "absent from activeKeys" as real evidence of disuse.
   */
  private connectedAt = new Map<string, number>();

  constructor(registry: ToolDescriptor[]) {
    this.registry = registry;
  }

  /**
   * Clear a key's cooldown so the next call attempts a real connect
   * immediately, instead of waiting out the remaining 60s. Called when
   * something changed that makes a retry worth trying right now: a manual
   * `bag auth` completion, or an explicit user-initiated retry.
   */
  clearCooldown(key: string): void {
    this.cooldownUntil.delete(key);
  }

  /** Whether `key` is within its post-failure cooldown window. */
  private isCoolingDown(key: string): boolean {
    const until = this.cooldownUntil.get(key);
    return until !== undefined && Date.now() < until;
  }

  /** Start (or restart) a 60s cooldown for `key` after a failed connect. */
  private startCooldown(key: string): void {
    this.cooldownUntil.set(key, Date.now() + COOLDOWN_MS);
  }

  /** Connect hook — overridable in tests to inject a fake connector */
  protected connect(
    config: BagServerConfig,
    resolvedEnv: Record<string, string>,
  ): Promise<ConnectedBagProxy | null> {
    return connectBagProxy(config, resolvedEnv);
  }

  /**
   * Get or create a connection for a credential bag.
   * Returns enriched tools on success, null on failure.
   * Concurrent calls for the same (bag, credentials) share a single attempt.
   */
  async getOrConnect(
    config: BagServerConfig,
    resolvedEnv: Record<string, string>,
    sessionId?: string,
  ): Promise<FilterableProxiedTool[] | null> {
    if (this.closed) throw new Error("bag connection pool is closed");
    const key = poolKey(config, resolvedEnv, sessionId);

    const existing = this.connections.get(key);
    if (existing) {
      log.debug("bag_pool.cache_hit", { bag: config.name, key });
      return existing.enrichedTools;
    }

    const pending = this.pendingConnects.get(key);
    if (pending) {
      log.debug("bag_pool.connect_join", { bag: config.name, key });
      return pending;
    }

    // A failed key must not pay another connection timeout before its cooldown expires.
    // Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
    if (this.isCoolingDown(key)) {
      log.debug("bag_pool.connect_cooldown", { bag: config.name, key });
      return null;
    }

    const attempt = (async () => {
      const proxy = await this.connect(config, resolvedEnv);
      if (!proxy) {
        this.startCooldown(key);
        return null;
      }

      const enrichedTools = enrichProxiedTools([proxy], this.registry, this.deferredBagNames);
      this.connections.set(key, { proxy, enrichedTools });
      this.connectedAt.set(key, Date.now());

      log.info("bag_pool.connected", {
        bag: config.name,
        key,
        tools: proxy.tools.length,
      });

      return enrichedTools;
    })();

    this.pendingConnects.set(key, attempt);
    try {
      return await attempt;
    } finally {
      this.pendingConnects.delete(key);
    }
  }

  /**
   * Single-flight connect for shared (credentialless) bag retries.
   *
   * Unlike getOrConnect, the connection is NOT stored in the pool cache —
   * cached entries are pruned when no session references their key, and
   * shared bags live in `pool.shared` instead (callers move the returned
   * tools there via addSharedToolsForBag).
   */
  async retryConnect(
    config: BagServerConfig,
    resolvedEnv: Record<string, string> = {},
  ): Promise<FilterableProxiedTool[] | null> {
    if (this.closed) throw new Error("bag connection pool is closed");
    const key = retryConnectKey(config, resolvedEnv);

    const pending = this.pendingRetries.get(key);
    if (pending) {
      log.debug("bag_pool.retry_join", { bag: config.name, key });
      return pending;
    }

    // Explicit recovery may clear a failed key’s cooldown before its deadline.
    // Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
    if (this.isCoolingDown(key)) {
      log.debug("bag_pool.retry_cooldown", { bag: config.name, key });
      return null;
    }

    const attempt = (async () => {
      const proxy = await this.connect(config, resolvedEnv);
      if (!proxy) {
        this.startCooldown(key);
        return null;
      }
      return enrichProxiedTools([proxy], this.registry, this.deferredBagNames);
    })();

    this.pendingRetries.set(key, attempt);
    try {
      return await attempt;
    } finally {
      this.pendingRetries.delete(key);
    }
  }

  /**
   * Collect tools for a session: shared tools + per-credential tools for needed bags.
   */
  async getToolsForSession(
    neededBags: string[],
    resolvedEnv: Record<string, string>,
    sessionId?: string,
  ): Promise<FilterableProxiedTool[]> {
    const sessionTools: FilterableProxiedTool[] = [...this.shared];

    const connected = await mapWithConcurrency(neededBags, 4, async bagName => {
      const config = this.deferredConfigs[bagName];
      return config ? this.getOrConnect(config, resolvedEnv, sessionId) : null;
    });
    for (const tools of connected) if (tools) sessionTools.push(...tools);

    return sessionTools;
  }

  /**
   * Check if a bag is OAuth-based (URL-only, no env, not localhost).
   */
  isBagOAuth(bagName: string): boolean {
    const config = this.originalConfigs[bagName];
    if (!config) return false;
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
   * Mark a bag as auth-expired: disconnect its proxy, remove its tools
   * from shared, and record the config for later retry.
   */
  markAuthExpired(bagName: string): void {
    const config = this.originalConfigs[bagName];
    if (!config) return;

    if (this.authExpired[bagName]) return;

    this.authExpired[bagName] = config;

    // Remove from shared tools. Close the shared proxy first — those tools
    // hold the only reference to it, so filtering them out without closing
    // strands the child process until the MCP server itself exits.
    const before = this.shared.length;
    disconnectSupersededShared(this, bagName);
    this.shared = this.shared.filter((t) => t.bag !== bagName);

    for (const [key, entry] of this.connections) {
      if (entry.proxy.name === bagName) {
        disconnectBagProxy(entry.proxy).catch(() => {});
        this.connections.delete(key);
        this.connectedAt.delete(key);
      }
    }

    this.connectedSharedBags.delete(bagName);
    delete this.needsAuth[bagName];
    delete this.failedSharedConfigs[bagName];

    log.warn("bag_pool.auth_expired", {
      bag: bagName,
      removedTools: before - this.shared.length,
      hint: `Run: barry bag auth ${bagName}`,
    });
  }

  /** Prune unreferenced connections only after their registration grace period.
   * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
   */
  pruneUnused(activeKeys: Set<string>): void {
    const now = Date.now();
    for (const [key, entry] of this.connections) {
      if (activeKeys.has(key)) continue;
      const connectedAt = this.connectedAt.get(key);
      if (connectedAt !== undefined && now - connectedAt < CONNECTION_SETTLE_GRACE_MS) {
        log.debug("bag_pool.prune_grace", { key, bag: entry.proxy.name });
        continue;
      }
      log.info("bag_pool.prune", { key, bag: entry.proxy.name });
      disconnectBagProxy(entry.proxy).catch(() => {});
      this.connections.delete(key);
      this.connectedAt.delete(key);
    }
  }

  /**
   * Get all connection cache keys currently referenced for a set of bags + env.
   */
  getActiveKeys(
    neededBags: string[],
    resolvedEnv: Record<string, string>,
    sessionId?: string,
  ): string[] {
    // Must key identically to getOrConnect: these keys mark connections as
    // in-use, and a mismatch would let the sweeper prune a live session's
    // connection out from under it.
    return neededBags
      .filter((name) => this.deferredConfigs[name])
      .map((name) => poolKey(this.deferredConfigs[name], resolvedEnv, sessionId));
  }

  /** Number of cached connections (for logging/debugging) */
  get connectionCount(): number {
    return this.connections.size;
  }
}

/**
 * Add a bag's freshly-connected tools to pool.shared, replacing any existing
 * entries for the same bag first. pool.shared is process-global and consulted
 * by every new session, so concurrent retries of the same bag must not append
 * duplicate tool entries.
 */
export function addSharedToolsForBag(
  pool: BagConnectionPool,
  bagName: string,
  tools: FilterableProxiedTool[],
): void {
  // The tools being replaced hold the only reference to the previous
  // connection (shared bags are not in `connections`, so `pruneUnused` can
  // never reach them). Dropping them without closing leaks the child process —
  // every retry/re-auth of a stdio bag stranded another one.
  disconnectSupersededShared(pool, bagName, tools);

  pool.shared = pool.shared.filter((t) => t.bag !== bagName);
  pool.shared.push(...tools);
  pool.connectedSharedBags.add(bagName);
}

/**
 * Close shared proxies for `bagName` that are about to lose their last
 * reference.
 *
 * `pool.shared` is the only handle on an eagerly-connected proxy, reached via
 * the `proxy` back-reference stamped on each enriched tool. `keep` lets a
 * caller exclude the incoming connection, so re-adding the same live proxy is
 * a no-op rather than a self-disconnect.
 */
function disconnectSupersededShared(
  pool: BagConnectionPool,
  bagName: string,
  keep: FilterableProxiedTool[] = [],
): void {
  const keepProxies = new Set(keep.map((t) => t.proxy));
  const seen = new Set<ConnectedBagProxy>();
  for (const tool of pool.shared) {
    if (tool.bag !== bagName) continue;
    if (keepProxies.has(tool.proxy) || seen.has(tool.proxy)) continue;
    seen.add(tool.proxy);
    log.debug("bag_pool.disconnect_superseded_shared", { bag: bagName });
    disconnectBagProxy(tool.proxy).catch(() => {});
  }
}
