import { toolDefinitions, toolContractHash } from "@barry-rocks/sdk/internal/tools";
import { readFileSync, statSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema, CallToolRequestSchema,
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema,
  SubscribeRequestSchema, UnsubscribeRequestSchema,
  ListPromptsRequestSchema, GetPromptRequestSchema, CompleteRequestSchema,
  McpError, ErrorCode, type CallToolResult, type ServerResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerTools, buildToolCallback, capToolResult, resultCharLimitFromEnv } from "@barry-rocks/sdk/tools";

import type { ToolContext, McpAnnotations } from "@barry-rocks/sdk/tools";
import {
  CORE_NAMESPACES,
  classifyFileWrite,
} from "@barry-rocks/sdk/bounds";
import type { ToolMeta } from "@barry-rocks/sdk/bounds";
import { record as recordChange } from "@barry-rocks/tracker-bag";
import { createLogger } from "@barry-rocks/sdk/logging";
import {
  patchServerWithProxiedTools,
  zodSchemaToJson,
  type FilterableProxiedTool,
  type BagConnectionPool,
} from "./bag-proxy.js";
import { searchDeferredTools } from "./tool-search.js";
import { getRegisteredTools, getRequestHandler, markToolHandlersInitialized, type RegisteredTool } from "./sdk-internals.js";
import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("mcp.tools", { transport: "stderr" });



const log = createLogger("tool-runtime", { transport: "stderr" });

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface ZodParseable {
  safeParseAsync(v: unknown): Promise<
    | { success: true; data: Record<string, unknown> }
    | { success: false; error: { message: string } }
  >;
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * Tag a description with its namespace — `[Linear] Fetch an issue`.
 *
 * This stands in for a real prefix on the aggregate `/mcp` endpoint, where
 * tools from every namespace share one `mcp__barry__` prefix and would
 * otherwise be indistinguishable. A namespace-scoped endpoint already gives the
 * agent `mcp__linear__*`, so the tag is pure noise there.
 */
function prefixDescription(
  description: string,
  namespace: string,
  namespaceScoped = false,
): string {
  if (namespaceScoped || !namespace || CORE_NAMESPACES.has(namespace)) return description;
  const label = namespace.charAt(0).toUpperCase() + namespace.slice(1);
  return `[${label}] ${description}`;
}

export interface RuntimeTool {
  namespace: string;
  access: "read" | "write";
  name: string;
  description: string;
  schema: z.ZodRawShape;
  secrets?: string[];
  deferred?: boolean;
  annotations?: McpAnnotations;
  /** MCP tool `_meta`, emitted verbatim in tools/list (e.g. `ui.resourceUri` for MCP Apps). */
  _meta?: Record<string, unknown>;
  /**
   * Opt-in plain-JSON-Schema output schema (see ToolDefinition.outputSchema).
   * Emitted verbatim on the tools/list entry; the matching call result carries
   * `structuredContent`, attached by registerTools — which then flows untouched
   * through both the SDK's tools/call handler and the bag-proxy patch.
   */
  outputSchema?: Record<string, unknown>;
  handler: (params: Record<string, unknown>, context?: ToolContext) => Promise<unknown>;
}

export const toToolList = toolDefinitions;

/**
 * Duplicate tool names across the loaded bags.
 *
 * Tool-name uniqueness is convention, not an enforced invariant, and several
 * lookups key on the bare name (tool-meta, the proxy dispatch map, the SDK's
 * own _registeredTools) where a duplicate silently last-write-wins — one bag
 * shadowing another's tool with no error anywhere. Surface it instead.
 *
 * Same-name-different-namespace is legal (each namespace is served on its own
 * endpoint, so the client sees distinct mcp__<ns>__ prefixes) but still worth
 * logging, because the bare name is what tool_search and call_tool take.
 */
export function findDuplicateToolNames(tools: RuntimeTool[]): {
  withinNamespace: string[];
  crossNamespace: string[];
} {
  const byKey = new Map<string, number>();
  const byName = new Map<string, Set<string>>();

  for (const tool of tools) {
    const key = `${tool.namespace}:${tool.name}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
    if (!byName.has(tool.name)) byName.set(tool.name, new Set());
    byName.get(tool.name)!.add(tool.namespace);
  }

  return {
    withinNamespace: [...byKey.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort(),
    crossNamespace: [...byName.entries()]
      .filter(([, namespaces]) => namespaces.size > 1)
      .map(([name, namespaces]) => `${name} (${[...namespaces].sort().join(", ")})`)
      .sort(),
  };
}

/**
 * Make tool names unique for the aggregate `/mcp` endpoint.
 *
 * Tool names are unique per namespace, not globally — ten bags define
 * `status`. A namespace endpoint serves one namespace, so bare names are fine
 * there, but `/mcp` serves all of them through one flat registry: the MCP SDK
 * throws "Tool status is already registered" on the second one, failing the
 * whole initialize.
 *
 * Colliding names get their namespace back (`git_status`); unique ones are left
 * alone, so the common case is untouched. Sessions that split namespaces never
 * see these — they address `mcp__git__status`.
 */
export function disambiguateToolNames(tools: RuntimeTool[]): RuntimeTool[] {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);

  // Names that survive as-is are reserved up front: a qualified name can collide
  // with one of them (git's `status` qualifies to `git_status`, which may
  // already exist as its own tool), and that tool may come later in the list.
  const used = new Set<string>();
  for (const tool of tools) if ((counts.get(tool.name) ?? 0) < 2) used.add(tool.name);

  return tools.map((tool) => {
    if ((counts.get(tool.name) ?? 0) < 2) return tool;

    const base = tool.namespace ? `${tool.namespace}_${tool.name}` : tool.name;
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    return { ...tool, name };
  });
}

export function toToolMeta(tools: RuntimeTool[]): ToolMeta[] {
  return tools.map((tool) => ({
    namespace: tool.namespace,
    toolName: tool.name,
    access: tool.access,
    contractHash: toolContractHash(tool),
    annotations: tool.annotations,
  }));
}

/**
 * How deferred tools are exposed to the client.
 * - "provider": all tools in tools/list — the client handles deferral (Claude Code)
 * - "barry": deferred tools hidden from tools/list, discoverable via tool_search
 *   and invokable via call_tool (works on any MCP client)
 */
export type ToolDiscovery = "provider" | "barry";

/**
 * What a session gets when nothing chose — an identity with no
 * `tool_discovery`, or no identity at all.
 *
 * `barry`, so a bag that marks its tools `deferred:` actually gets the effect it
 * asked for. Under `provider` the flag is inert: `tools/list` returns everything
 * and deferral is the client's problem, so a bag author who deferred a whole
 * surface still paid for it in every context window.
 *
 * EXPORTED AND USED EVERYWHERE, rather than repeating `?? "provider"`. Three
 * places decide deferral behaviour — this module's `tools/list` filter and two
 * `keepDeferred` computations in `index.ts` — and the two in `index.ts` test
 * `=== "barry"` against a value that is `undefined` when no identity set it. A
 * default applied in only one of the three would hide tools from `tools/list`
 * while the aggregate stripped the deferred catalog, leaving them unreachable:
 * findable by neither route. They must agree, so they read one constant.
 */
export const DEFAULT_TOOL_DISCOVERY: ToolDiscovery = "barry";

/** The chosen mode, or the default when nothing chose. */
export function resolveToolDiscovery(chosen: ToolDiscovery | undefined): ToolDiscovery {
  return chosen ?? DEFAULT_TOOL_DISCOVERY;
}

export interface CreateToolServerOptions {
  authorize?: () => Promise<boolean>;
  tools: RuntimeTool[];
  proxiedTools?: FilterableProxiedTool[];
  pool?: BagConnectionPool;
  toolDiscovery?: ToolDiscovery;
  /** Set when this server serves exactly one namespace (`/mcp/ns/<ns>`). */
  namespaceScoped?: boolean;
  /**
   * Bag-contributed MCP resource registrations (mcp-adapter's
   * `registerMcpResources`, context pre-bound by the caller). Invoked here —
   * before the caller connects a transport — so the SDK declares the
   * `resources` capability during initialize.
   */
  resourceRegistrars?: Array<(server: McpServer) => void>;
  /**
   * The session this server instance serves, if any. Threaded through to
   * patchServerWithProxiedTools so its tools/call handler can deliver
   * queued phone messages on this session's next tool call — see
   * queuePrompt in bags/sessions/api's message route.
   */
  barrySessionId?: string;
}

/**
 * A live tool server plus the lever to change what it serves.
 *
 * A bag enabled mid-session changes what the session may use, and before this
 * there was no path from that DB write to an already-connected client: the
 * `tools/list` handler answered from what it captured at initialize, so even a
 * client that re-asked was told the same thing forever.
 */
export interface ToolServerHandle {
  server: McpServer;
  /**
   * Replace the served tools, returning whether the visible list actually
   * changed. Callers use that to skip notifying a client about nothing — and a
   * test uses it to tell a real swap from a silent no-op, which is the failure
   * mode this mechanism is most prone to.
   */
  refreshTools(next: { tools: RuntimeTool[]; proxiedTools?: FilterableProxiedTool[] }): boolean;
  /** Names currently visible in `tools/list`, sorted, for logging and assertions. */
  visibleToolNames(): string[];
}

/** Registered by the server itself, so absent from any session's RuntimeTool list. */
const BUILTIN_TOOL_NAMES = new Set(["tool_search", "call_tool"]);

export function createToolServer(
  toolsOrOpts: RuntimeTool[] | CreateToolServerOptions,
  proxiedTools?: FilterableProxiedTool[],
  pool?: BagConnectionPool,
): McpServer {
  return createToolServerHandle(toolsOrOpts, proxiedTools, pool).server;
}

export function createToolServerHandle(
  toolsOrOpts: RuntimeTool[] | CreateToolServerOptions,
  proxiedTools?: FilterableProxiedTool[],
  pool?: BagConnectionPool,
): ToolServerHandle {
  // Support both old positional args and new options object
  const opts: CreateToolServerOptions = Array.isArray(toolsOrOpts)
    ? { tools: toolsOrOpts, proxiedTools, pool }
    : toolsOrOpts;
  const authorize = opts.authorize;
  const guarded = new WeakSet<object>();
  async function authorizationAllowed(): Promise<boolean> {
    if (!authorize) return true;
    try { return await authorize() === true; }
    catch { return false; }
  }
  function guardTool(tool: RuntimeTool): RuntimeTool {
    if (!authorize) return tool;
    return { ...tool, handler: async (params, context) => {
      if (!await authorizationAllowed() || getRegisteredTools(server)[tool.name]?.enabled === false) {
        throw new Error("Authorization unavailable");
      }
      return await tool.handler(params, context);
    } };
  }
  function guardCalls(): void {
    if (!authorize) return;
    const dispatch = getRequestHandler(server.server, "tools/call");
    if (!dispatch || guarded.has(dispatch)) return;
    const call = async (request: unknown, extra: unknown): Promise<CallToolResult> => {
      if (!await authorizationAllowed()) return errorResult("Authorization unavailable");
      return await dispatch(request, extra) as CallToolResult;
    };
    guarded.add(call);
    server.server.setRequestHandler(CallToolRequestSchema, call);
  }
  const tools = opts.tools;
  // ONE array identity for proxied tools, shared by the proxy patch, the
  // deferred catalog, and tools/list. refreshTools mutates it IN PLACE, so
  // every closure that captured it at construction stays current — replacing
  // the array would silently strand them on the old contents.
  const proxiedRef: FilterableProxiedTool[] = [...(opts.proxiedTools ?? [])];
  const connectionPool = opts.pool;
  const discovery = resolveToolDiscovery(opts.toolDiscovery);
  const namespaceScoped = opts.namespaceScoped ?? false;

  const server = new McpServer({ name: "barry", version: "1.0.0" }, {
    debouncedNotificationMethods: ["notifications/tools/list_changed", "notifications/resources/list_changed", "notifications/prompts/list_changed"],
  });
  // Names as actually registered — on the aggregate endpoint these may be
  // namespace-qualified to stay unique, so every downstream lookup keyed by
  // name must use this list rather than the caller's.
  const registeredToolList = namespaceScoped ? tools : disambiguateToolNames(tools);
  // Cap results at the model-facing boundary: everything this server returns
  // toward an agent is bounded, no matter which bag produced it.
  // One options object for every registration this server ever does — initial,
  // refresh-added, and refreshed-handler swaps — so their behavior cannot drift.
  //
  // Per-call timing and outcome. Nothing recorded this before, so a tool that
  // was slow or failing was indistinguishable from one that was never called
  // — and "which tool is wedging sessions" had no answer at all.
  //
  // A failed call logs at warn so it surfaces without a filter; a slow one is
  // left at info because slow is a judgement the dashboard makes from
  // percentiles, not something to decide per call with a hardcoded threshold.
  const registerOptions = {
    resultCharLimit: resultCharLimitFromEnv(),
    onToolCall: ({ name, durationMs, ok, error }: { name: string; durationMs: number; ok: boolean; error?: string }) => {
      log[ok ? "info" : "warn"]("mcp.tool_call", { tool: name, duration_ms: durationMs, ok, error });
    },
  };
  registerTools(server, registeredToolList.map(guardTool), registerOptions);

  // Bag-contributed resources (MCP Apps viewers, byte-serving templates).
  // A registrar that throws loses its resources, not the whole server.
  for (const registerResources of opts.resourceRegistrars ?? []) {
    try {
      registerResources(server);
    } catch (error) {
      log.error("tool_server.resource_registrar_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // In barry mode, register tool_search + call_tool BEFORE patchServerWithProxiedTools
  // (which overrides the tools/call handler — our tools must be registered first so
  // they appear in the SDK's _registeredTools map and get dispatched by the patch).
  const deferredCatalog = discovery === "barry"
    ? [
        // Registered names, so a tool_search hit is directly callable via call_tool.
        ...registeredToolList.filter((t) => t.deferred).map((t) => ({
          name: t.name,
          description: prefixDescription(t.description, t.namespace, namespaceScoped),
          inputSchema: zodSchemaToJson(t.schema, t.name),
          namespace: t.namespace,
        })),
        ...proxiedRef.filter((t) => t.deferred).map((t) => ({
          name: t.name,
          description: prefixDescription(t.description, t.namespace, namespaceScoped),
          inputSchema: t.inputSchema,
          namespace: t.namespace,
        })),
      ]
    : [];
  const deferredNames = new Set(deferredCatalog.map((t) => t.name));

  // call_tool's proxied dispatch map — same in-place contract as proxiedRef:
  // refreshTools clears and repopulates it so the call_tool closure stays live.
  const proxiedByName = new Map(proxiedRef.filter((t) => t.deferred).map((t) => [t.name, t]));

  // Registered for the WHOLE LIFE of a barry-mode server, empty catalog or not.
  //
  // The SDK installs its tools/list + tools/call handlers on the first
  // registration and refuses `registerCapabilities` once a transport is
  // connected, so this is the only moment meta-tools can appear. Gating on
  // `deferredCatalog.length > 0` therefore made the decision permanently on a
  // snapshot of the session's FIRST resolution — and a session gains deferred
  // tools later all the time: enabling a bag mid-session (POST /refresh-tools),
  // or a fail-closed resolve healing itself (scheduleResolveRetry). Either way
  // the tools arrived with no way to reach them, and `refreshTools` could only
  // fall back to listing them visibly.
  //
  // The cost of being wrong in the other direction is two entries in
  // `tools/list` (~150 tokens) and a `tool_search` that returns []. The cost of
  // being wrong this way was a tool that is granted, registered, hidden, and
  // unreachable — which is indistinguishable from one that was never granted.
  //
  // Safe because `BUILTIN_TOOL_NAMES` exempts both names from the `allowed`
  // gate in `listedTools()`, so they survive every refresh, and `call_tool`
  // dispatches through the SDK registry rather than the catalog — it is a
  // working general-purpose dispatcher even when nothing is deferred.
  const metaToolsRegistered = discovery === "barry";

  if (metaToolsRegistered) {
    server.tool(
      "tool_search",
      "Search for additional tools by keyword. Many tools are available but not listed by default. Use call_tool to invoke any tool found here.",
      {
        query: z.string().describe("Keywords to match against tool names and descriptions"),
        max_results: z.number().optional().describe("Maximum results to return (default 5)"),
      },
      async ({ query, max_results }) => ({
        content: [{
          type: "text" as const,
          text: JSON.stringify(searchDeferredTools(deferredCatalog, query, max_results ?? 5), null, 2),
        }],
      }),
    );

    // Capture the registeredTools ref early — it's populated by registerTools above.
    const nativeTools = getRegisteredTools(server);

    server.tool(
      "call_tool",
      "Call any tool by name, including deferred tools discovered via tool_search.",
      {
        name: z.string().describe("Name of the tool to call"),
        arguments: z.record(z.string(), z.unknown()).optional().describe("Arguments to pass to the tool"),
      },
      async ({ name: toolName, arguments: toolArgs }): Promise<ToolResult> => {
        if (!await authorizationAllowed()) return errorResult("Authorization unavailable");
        const args = toolArgs ?? {};

        // Try proxied tools first (they have their own client dispatch)
        const proxied = proxiedByName.get(toolName);
        if (proxied) {
          try {
            const live = connectionPool?.shared.find(
              (t) => t.bag === proxied.bag && t.name === toolName,
            )?.proxy ?? proxied.proxy;
            const relayed = await live.client.callTool({ name: toolName, arguments: args });
            return capToolResult(relayed, resultCharLimitFromEnv()) as ToolResult;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return errorResult(message);
          }
        }

        // Try native registered tools — dispatch mirrors the SDK's own
        // tools/call handler (validate + call handler(parsedArgs, extra)).
        const tool = nativeTools[toolName];
        if (!tool) {
          return errorResult(`Unknown tool: ${toolName}`);
        }
        // "Mirrors the SDK's handler" has to include its ENABLED check, or this
        // path becomes a way around revocation. refreshTools disables a revoked
        // tool's record, which stops tools/call — but this dispatch reads the
        // same registry and only tested for existence, so call_tool still
        // executed the handler and its captured credentials. Reachable by any
        // barry with tool_discovery: "barry", where call_tool is registered.
        if (!tool.enabled) {
          return errorResult(`Unknown tool: ${toolName}`);
        }

        try {
          const schema = tool.inputSchema as ZodParseable | undefined;
          if (schema?.safeParseAsync) {
            const parsed = await schema.safeParseAsync(args);
            if (!parsed.success) {
              return errorResult(`Invalid arguments: ${parsed.error.message}`);
            }
            return await tool.handler(parsed.data, {}) as ToolResult;
          }
          return await tool.handler(args, {}) as ToolResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return errorResult(message);
        }
      },
    );
  }

  // Ensure the tools capability is always declared so tools/list returns an
  // empty list instead of crashing with "Server does not support tools". The
  // SDK only registers the capability when server.tool() is called at least
  // once, so force it when no native tools were registered.
  if (tools.length === 0 && deferredCatalog.length === 0) {
    server.server.registerCapabilities({ tools: { listChanged: true } });
  }

  // A server that registered NOTHING at construction must complete its own
  // handlers: the SDK installs tools/list + tools/call on the FIRST
  // registerTool, which collides with the custom list handler below and — once
  // a transport is connected — throws "Cannot register capabilities after
  // connecting". Without this, a toolless server (degraded init) could never
  // accept the tools a self-heal refresh brings: the retry failed forever,
  // which is exactly how the bug surfaced live. The proxy patch is a complete
  // tools/call (proxied + native dispatch), so owning both handlers is safe.
  const startedToolless = registeredToolList.length === 0 && !metaToolsRegistered;
  let proxyPatchInstalled = proxiedRef.length > 0 || startedToolless;
  if (proxyPatchInstalled) {
    patchServerWithProxiedTools(server, proxiedRef, connectionPool, {
      force: startedToolless,
      barrySessionId: opts.barrySessionId,
      // Proxied bags never reach registerTools, so this is the only place a
      // remote bag's calls can be observed. Same shape and same log line as the
      // native path, so both read identically downstream.
      onToolCall: registerOptions.onToolCall,
    });
  }
  if (startedToolless) markToolHandlersInitialized(server);
  guardCalls();

  const registeredTools = getRegisteredTools(server);

  /**
   * Everything `tools/list` derives from beyond the SDK's own registry, in one
   * replaceable box. The handler reads through this rather than closing over
   * the maps directly — which is the whole point: `refreshTools` swaps the box
   * and the next `tools/list` answer reflects it. `registeredTools` is the
   * SDK's live map (it grows as tools register) so it is read through, never
   * reassigned; `proxiedRef` is mutated in place, never replaced.
   */
  let listState = buildListState(registeredToolList, deferredNames);

  function buildListState(runtimeTools: RuntimeTool[], deferred: Set<string>) {
    return {
      namespaceByName: new Map(runtimeTools.map((t) => [t.name, t.namespace])),
      // `_meta` is not stored in the SDK's _registeredTools, so carry it from the
      // RuntimeTool list. Without this, MCP-Apps hosts never see `ui.resourceUri`.
      metaByName: new Map(runtimeTools.filter((t) => t._meta).map((t) => [t.name, t._meta!])),
      // Same story for `outputSchema`: ours is plain JSON Schema, which the SDK's
      // zod-only slot cannot hold (see registerTools), so tools/list entries get it
      // from the RuntimeTool list — emitted verbatim, exactly as the MCP spec ships
      // it on a Tool. Without this, clients would receive structuredContent for a
      // tool whose listing never declared a schema for it.
      outputSchemaByName: new Map(
        runtimeTools.filter((t) => t.outputSchema).map((t) => [t.name, t.outputSchema!]),
      ),
      deferredNames: deferred,
      // Gate for tools the SDK still has registered but this session no longer
      // has: a refresh cannot unregister from the SDK's map, so without this a
      // revoked tool would keep appearing forever.
      allowed: new Set(runtimeTools.map((t) => t.name)),
    };
  }

  function listedTools() {
    const state = listState;
    return [
      ...Object.entries(registeredTools)
        .filter(([name, tool]) => {
          if (!tool.enabled) return false;
          if (!state.allowed.has(name) && !BUILTIN_TOOL_NAMES.has(name)) return false;
          // barry mode hides deferred tools (reached via tool_search + call_tool);
          // provider mode lists everything and the client handles deferral.
          return discovery === "barry" ? !state.deferredNames.has(name) : true;
        })
        .map(([name, tool]) => ({
          name,
          description: prefixDescription(tool.description ?? "", state.namespaceByName.get(name) ?? "", namespaceScoped),
          inputSchema: zodSchemaToJson(tool.inputSchema, name),
          ...(state.outputSchemaByName.has(name) ? { outputSchema: state.outputSchemaByName.get(name) } : {}),
          annotations: tool.annotations,
          ...(state.metaByName.has(name) ? { _meta: state.metaByName.get(name) } : {}),
        })),
      ...proxiedRef
        .filter((tool) => (discovery === "barry" ? !tool.deferred : true))
        .map((tool) => ({
          name: tool.name,
          description: prefixDescription(tool.description, tool.namespace, namespaceScoped),
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
    ];
  }

  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listedTools() }));
  if (authorize) {
    const requests = [
      ["tools/list", ListToolsRequestSchema],
      ["resources/list", ListResourcesRequestSchema],
      ["resources/templates/list", ListResourceTemplatesRequestSchema],
      ["resources/read", ReadResourceRequestSchema],
      ["resources/subscribe", SubscribeRequestSchema],
      ["resources/unsubscribe", UnsubscribeRequestSchema],
      ["prompts/list", ListPromptsRequestSchema],
      ["prompts/get", GetPromptRequestSchema],
      ["completion/complete", CompleteRequestSchema],
    ] as const;
    for (const [method, schema] of requests) {
      const dispatch = getRequestHandler(server.server, method);
      if (!dispatch) continue;
      server.server.setRequestHandler(schema, async (request, extra) => {
        if (!await authorizationAllowed()) throw new McpError(ErrorCode.InvalidRequest, "Authorization unavailable");
        return await dispatch(request, extra) as ServerResult;
      });
    }
  }

  return {
    server,
    visibleToolNames: () => listedTools().map((t) => t.name).sort(),
    refreshTools(next) {
      const before = listedTools().map((t) => t.name).sort().join(" ");

      const nextList = namespaceScoped ? next.tools : disambiguateToolNames(next.tools);

      // Tools the SDK has never seen must be registered, or they would be
      // listed but not callable — the worst of the outcomes, since the agent
      // gets an affordance that errors when used. Tools that persist across the
      // refresh keep their originally registered handlers.
      const known = new Set(Object.keys(registeredTools));
      const unregistered = nextList.filter((t) => !known.has(t.name));
      if (unregistered.length > 0) registerTools(server, unregistered.map(guardTool), registerOptions);

      // Persisting tools get their HANDLERS swapped in place. The re-resolution
      // re-wrapped them with fresh secrets and session context, and serving the
      // init-time closure would quietly pin credentials to session start. The
      // SDK throws on duplicate registration, so this overwrites the registered
      // record's handler — the same sanctioned reach-in getRegisteredTools is.
      const unregisteredNames = new Set(unregistered.map((t) => t.name));
      for (const t of nextList) {
        const record = registeredTools[t.name];
        if (!record || unregisteredNames.has(t.name)) continue;
        record.handler = buildToolCallback(guardTool(t), registerOptions) as RegisteredTool["handler"];
        if (t.description) record.description = t.description;
      }

      // In-place swap keeps the proxy patch and call_tool dispatch closures live.
      proxiedRef.length = 0;
      proxiedRef.push(...(next.proxiedTools ?? []));
      if (!proxyPatchInstalled && proxiedRef.length > 0) {
        // The session gained its first proxied tools mid-life; without the
        // patch, the SDK's default tools/call handler would reject their names.
        patchServerWithProxiedTools(server, proxiedRef, connectionPool, {
          barrySessionId: opts.barrySessionId,
          onToolCall: registerOptions.onToolCall,
        });
        proxyPatchInstalled = true;
      }

      let nextDeferred: Set<string>;
      if (metaToolsRegistered) {
        deferredCatalog.length = 0;
        deferredCatalog.push(
          ...nextList.filter((t) => t.deferred).map((t) => ({
            name: t.name,
            description: prefixDescription(t.description, t.namespace, namespaceScoped),
            inputSchema: zodSchemaToJson(t.schema, t.name),
            namespace: t.namespace,
          })),
          ...proxiedRef.filter((t) => t.deferred).map((t) => ({
            name: t.name,
            description: prefixDescription(t.description, t.namespace, namespaceScoped),
            inputSchema: t.inputSchema,
            namespace: t.namespace,
          })),
        );
        proxiedByName.clear();
        for (const t of proxiedRef.filter((p) => p.deferred)) proxiedByName.set(t.name, t);
        nextDeferred = new Set(deferredCatalog.map((t) => t.name));
      } else {
        // Apply deferred-discovery gating only where deferred discovery was actually enabled.
        // Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-017
        nextDeferred = new Set();
      }

      listState = buildListState(nextList, nextDeferred);

      // Revocation must remove the AFFORDANCE, not just the listing.
      //
      // listedTools() consults listState.allowed, so a revoked tool vanishes
      // from tools/list — but its RegisteredTool record survives with a live
      // handler, and the SDK dispatches tools/call by that record. A client
      // that kept the name (or read it before the refresh) could still invoke
      // it, executing the handler built at registration time along with the
      // credential closure captured then. Barry's own call_tool path reached it
      // the same way. Listing-only revocation is a UI change wearing a
      // permission's clothes.
      //
      // Disabling is the SDK's supported way to make a registered tool
      // non-callable; the record stays so a later refresh can re-enable it
      // rather than fighting the SDK's duplicate-registration throw.
      const stillAllowed = new Set(nextList.map((t) => t.name));
      for (const [name, record] of Object.entries(registeredTools)) {
        if (BUILTIN_TOOL_NAMES.has(name)) continue;
        const permitted = stillAllowed.has(name);
        if (record.enabled === permitted) continue;
        if (permitted) record.enable();
        else record.disable();
      }

      const after = listedTools().map((t) => t.name).sort().join(" ");
      guardCalls();
      return before !== after;
    },
  };
}

export { applyBoundGuards } from "@barry-rocks/sdk/bounds";

const editTools = new Set(["Write", "Edit", "MultiEdit"]);

function recordFileEdit(toolName: string, filePath: string, params: Record<string, unknown>, sessionId: string): void {
  const diff = toolName === "Write"
    ? { type: "full", content: params.content }
    : toolName === "Edit"
      ? { type: "edit", old_string: params.old_string, new_string: params.new_string }
      : { type: "multi_edit", edits: params.edits };
  let sizeBytes: number | undefined;
  try {
    sizeBytes = statSync(filePath).size;
  } catch {
    // A write may report before the new path is visible to stat.
  }
  recordChange({ sessionId, filePath, tool: toolName, diff, sizeBytes });
}

/**
 * Make editing a file claim it, and make claiming require saying why.
 *
 * Parallel sessions share one working tree, so two agents editing the same file
 * silently clobber each other. Rather than offer lock tools an agent must
 * remember to call, this folds locking into the edit itself: the wrapper adds a
 * required `intent` parameter to Write/Edit/MultiEdit, claims the region on the
 * way through, and puts an overlapping claim to the user.
 *
 * Two properties follow from doing it here rather than in a separate tool:
 * every edit carries an intent (the old design only captured one when an agent
 * bothered to call acquire), and there is nothing to discover or forget.
 *
 * Fails OPEN. A missing bag, an unreadable DB, or any throw lets the edit
 * proceed — a coordination aid that bags work when it breaks is worse than
 * none. Only a genuine, confirmed conflict stops an edit.
 */
type AcquireForEdit = (options: {
  filePath: string;
  sessionId: string;
  intent: string;
  /** Bytes this edit touches; omitted/null means the whole file. */
  region?: { start: number; end: number } | null;
}) => Promise<
  | { ok: true; coexisting?: Array<{ session: string; intent: string; since: string }> }
  | { ok: false; path: string; conflicts: Array<{ session: string; intent: string; since: string }> }
>;

/** Asks the user to arbitrate; resolves once they answer. */
export type EscalateToUser = (options: {
  path: string;
  myIntent: string;
  conflicts: Array<{ session: string; intent: string; since: string }>;
}) => Promise<boolean>;

let acquireForEdit: AcquireForEdit | null | undefined;

/** Test seam: inject an acquirer, or null to disable enforcement. */
export function setAcquireForEdit(fn: AcquireForEdit | null | undefined): void {
  acquireForEdit = fn;
}

async function resolveAcquire(): Promise<AcquireForEdit | null> {
  if (acquireForEdit !== undefined) return acquireForEdit;
  acquireForEdit = null;
  try {
    const mod = await import("@barry-rocks/locks-bag");
    if (typeof mod.acquireForEdit === "function") acquireForEdit = mod.acquireForEdit;
  } catch {
    // Locks bag absent or unloadable — editing is simply unguarded.
  }
  return acquireForEdit ?? null;
}

const INTENT_DESCRIPTION =
  "One line on what you are changing in this file and why. Recorded against the file so other " +
  "sessions working in this checkout can see what you are doing.";

/**
 * The bytes an edit will touch, for conflict comparison.
 *
 * `Edit` knows its own `old_string`, so the range is derivable from the file on
 * disk without asking a model — which keeps coordination off the write hot path
 * and its verdict deterministic.
 *
 * Everything uncertain returns null, meaning "the whole file": a `Write`
 * genuinely replaces everything, a `MultiEdit` spans an unknown set of ranges,
 * and an unreadable file or an `old_string` that is not present tells us
 * nothing. Null conflicts with every live intent, so uncertainty escalates to
 * the user rather than quietly proceeding.
 */
function editRegion(
  toolName: string,
  filePath: string,
  params: Record<string, unknown>,
): { start: number; end: number } | null {
  if (toolName !== "Edit") return null;

  const oldString = params.old_string;
  if (typeof oldString !== "string" || oldString === "") return null;

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const start = content.indexOf(oldString);
  if (start === -1) return null;

  // `replace_all` touches every occurrence, so the span runs to the end of the
  // last match. Wider than the true footprint, and deliberately so.
  if (params.replace_all === true) {
    const last = content.lastIndexOf(oldString);
    return { start, end: last + oldString.length };
  }

  return { start, end: start + oldString.length };
}

export function wrapEditIntent(
  tools: RuntimeTool[],
  sessionId: string,
  // The arbiter is a closure parameter, NOT module state: as a module-level
  // global reassigned per connection, session A's conflict could escalate to
  // whichever session connected last. Null fails closed on conflict.
  escalateToUser: EscalateToUser | null = null,
): RuntimeTool[] {
  return tools.map((tool) => {
    if (!editTools.has(tool.name)) return tool;
    const original = tool.handler;
    return {
      ...tool,
      // Extending the schema is what makes the intent mandatory: the agent
      // cannot call the tool without one, so there is no path to an unexplained
      // edit and no separate step to skip.
      schema: { ...tool.schema, intent: z.string().min(1).describe(INTENT_DESCRIPTION) },
      description:
        `${tool.description} Requires \`intent\`: one line on what you are changing. ` +
        `This also claims the part you edit; overlapping edits between sessions wait for the user to decide.`,
      handler: async (params, context) => {
        const filePath = params.file_path;
        const intent = typeof params.intent === "string" ? params.intent.trim() : "";

        if (typeof filePath === "string" && intent) {
          let conflict: { path: string; conflicts: Array<{ session: string; intent: string; since: string }> } | null =
            null;
          let coexisting: Array<{ session: string; intent: string; since: string }> = [];
          try {
            const acquire = await resolveAcquire();
            const result = await acquire?.({
              filePath,
              sessionId,
              intent,
              region: editRegion(tool.name, filePath, params),
            });
            if (result && !result.ok) conflict = result;
            else if (result && result.ok) coexisting = result.coexisting ?? [];
          } catch {
            conflict = null; // fail open
          }

          if (conflict) {
            // Regions genuinely overlap, so the machine does not pick a winner.
            // Fails CLOSED: with no arbiter wired, a real conflict blocks rather
            // than resolving itself silently in favour of whoever asked last.
            const allowed = escalateToUser
              ? await escalateToUser({ path: conflict.path, myIntent: intent, conflicts: conflict.conflicts })
              : false;

            if (!allowed) {
              const other = conflict.conflicts[0];
              throw new Error(
                `Edit to '${conflict.path}' was not approved. Session ${other?.session} is changing the same ` +
                  `region, which is: "${other?.intent}"${other?.since ? ` (${other.since})` : ""}. ` +
                  `Your intent ("${intent}") stays recorded and is visible via locks_contention. ` +
                  `Work on something else, or edit a different part of the file.`,
              );
            }
          }

          // Non-conflicting neighbours are surfaced, not swallowed: knowing what
          // else is in flight in this file is the point of declaring intent.
          if (coexisting.length > 0) {
            const list = coexisting.map((c) => `${c.session} ("${c.intent}", ${c.since})`).join("; ");
            diagnostics.error("mcp.edit_coordination", { detail: `edit-coordination: ${filePath} also being worked on by ${list}` });
          }
        }

        // `intent` is ours, not the underlying tool's — strip it before calling.
        const { intent: _intent, ...rest } = params;
        return original(rest, context);
      },
    };
  });
}

/**
 * Stop the shell from being a side door around the edit tools.
 *
 * `wrapEditIntent` makes editing declare an intent and claim the file, but only
 * for the tools it wraps. An agent that runs `python3 -c "open('x.ts','w')..."`
 * or `sed -i` patches the file with no claim at all — and reaching for a Python
 * one-liner is a habit modern agents have, not an edge case. Native editors are
 * already denied, so the shell was the remaining gap.
 *
 * This refuses the command and names the tool to use instead. It does NOT try
 * to be exhaustive: `classifyFileWrite` is tuned against false positives,
 * because a guard that bags `pnpm test > /dev/null` gets switched off and
 * then protects nothing. Anything it misses is still recorded by the
 * change-tracker, which is the backstop.
 */
export function wrapShellEditGuard(tools: RuntimeTool[]): RuntimeTool[] {
  return tools.map((tool) => {
    if (tool.name !== "Bash") return tool;
    const original = tool.handler;
    return {
      ...tool,
      handler: async (params, context) => {
        const command = typeof params.command === "string" ? params.command : "";
        let finding: ReturnType<typeof classifyFileWrite> = null;
        try {
          finding = classifyFileWrite(command);
        } catch {
          finding = null; // never let the guard itself break a command
        }

        if (finding) {
          const target = finding.path ? `'${finding.path}'` : "a file";
          throw new Error(
            `This command writes ${target} from the shell (${finding.reason}), which skips file claiming.\n\n` +
              `Use the Write, Edit or MultiEdit tool instead. They take an \`intent\` — one line on what you are ` +
              `changing — which claims what you edit so parallel sessions in this checkout cannot silently clobber each other.\n\n` +
              `If you are generating a file rather than editing one, still write it with the Write tool. ` +
              `Shell redirection and in-place editors are only refused for files; piping to /dev/null, ` +
              `reading, and running tests are unaffected.`,
          );
        }

        return original(params, context);
      },
    };
  });
}

export function wrapEditRecording(tools: RuntimeTool[], sessionId: string): RuntimeTool[] {
  return tools.map((tool) => {
    if (!editTools.has(tool.name)) return tool;
    const original = tool.handler;
    return {
      ...tool,
      handler: async (params) => {
        const result = await original(params);
        const filePath = params.file_path;
        if (typeof filePath === "string") {
          try {
            recordFileEdit(tool.name, filePath, params, sessionId);
          } catch {
            // Recording is observational and must not fail the tool call.
          }
        }
        return result;
      },
    };
  });
}

export function wrapSecretInjection(
  tools: RuntimeTool[],
  resolvedEnv: Record<string, string>,
  sessionId?: string,
  availableTools?: string[],
  bagNames?: string[],
): RuntimeTool[] {
  return tools.map((tool) => {
    // Standalone catalogs still need explicit scope, even without credentials or a session.
    if (!tool.secrets?.length && !sessionId && availableTools === undefined && bagNames === undefined) return tool;
    const secrets = tool.secrets?.length
      ? Object.fromEntries(
          tool.secrets.filter((name) => resolvedEnv[name] !== undefined).map((name) => [name, resolvedEnv[name]]),
        )
      : {};
    const original = tool.handler;
    return {
      ...tool,
      handler: async (params) => {
        const missing = (tool.secrets ?? []).filter((name) => !secrets[name]);
        if (missing.length) throw new Error(`Missing required secrets: ${missing.join(", ")}`);
        return original(params, {
          secrets,
          sessionId,
          ...(availableTools ? { availableTools } : {}),
          // Spread-when-present, like availableTools: a handler distinguishes
          // "no session scope known" from "a session that enabled nothing" by
          // the field's absence, and scoping a catalog to an empty list would
          // look identical to an empty machine.
          ...(bagNames ? { bagNames } : {}),
        });
      },
    };
  });
}
