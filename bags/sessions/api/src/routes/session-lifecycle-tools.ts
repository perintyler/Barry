import { Barry, requestCaller, type Bound, type Tool } from "@barry-rocks/sdk";
import { createLogger } from "@barry-rocks/sdk/logging";
import { sessionsRoutes } from "@barry-rocks/sdk/internal/routes";
import type { serve } from "@barry-rocks/sdk/services/http";
import { filterToolsQualified, qualifyToolId } from "@barry-rocks/sdk/bounds";
import { collectToolDefinitions, type ToolDescriptorEntry } from "@barry-rocks/sdk/internal/tools";
import { getSessionRecord } from "../db.js";

const log = createLogger("barry-server");

interface ResolvedToolsResponse {
  ok: true;
  bags: {
    active: string[];
    available: string[];
  };
  bounds: Array<Bound | string>;
  availableBounds: string[];
  bound: Record<string, unknown> | null;
  /** Namespaces directly selected (additive, independent of bags) */
  selectedNamespaces: string[];
  /** Tools directly selected (additive, independent of bags) */
  selectedTools: string[];
  namespaces: Array<{
    name: string;
    enabled: boolean;
    grantedBy: string[];
    toolCount: number;
  }>;
  tools: Array<{
    toolName: string;
    namespace: string;
    access: string;
    enabled: boolean;
    grantedBy: string | null;
  }>;
}

/**
 * Every tool a bag declares, marked with whether the session's bags and bound
 * reach it and what enabled it: the bag naming its namespace, else a direct pick.
 */
function annotateTools(
  resolvedTools: readonly Tool[],
  activeBags: readonly string[],
  activeBound: Bound | null,
  universe: readonly ToolDescriptorEntry[],
  direct: { namespaces: readonly string[]; tools: readonly string[] },
): Pick<ResolvedToolsResponse, "namespaces" | "tools"> {
  const activeBagSet = new Set(activeBags);
  const enabledToolIds = new Set(resolvedTools.map((tool) => qualifyToolId(tool.namespace, tool.name)));

  if (direct.namespaces.length > 0 || direct.tools.length > 0) {
    const directCandidates = universe.filter(
      (t) => direct.namespaces.includes(t.namespace) || direct.tools.includes(t.toolName),
    );
    const allowedDirect = new Set(filterToolsQualified(directCandidates, activeBound));
    for (const id of allowedDirect) enabledToolIds.add(id);
  }

  const enabledNamespaces = new Set<string>([
    ...activeBags,
    ...direct.namespaces,
  ]);

  const toolCounts = new Map<string, number>();
  for (const tool of universe) toolCounts.set(tool.namespace, (toolCounts.get(tool.namespace) ?? 0) + 1);
  const namespaces = [...toolCounts.entries()]
    .map(([name, toolCount]) => {
      const enabled = enabledNamespaces.has(name);
      const grantedBy = activeBagSet.has(name) ? [name] : [];
      return { name, enabled, grantedBy, toolCount };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const tools = universe.map((tool) => {
    const enabled = enabledToolIds.has(qualifyToolId(tool.namespace, tool.toolName));
    let grantedBy: string | null = null;
    if (enabled) {
      if (activeBagSet.has(tool.namespace)) {
        grantedBy = tool.namespace;
      } else if (direct.namespaces.includes(tool.namespace)) {
        grantedBy = "(direct namespace)";
      } else if (direct.tools.includes(tool.toolName)) {
        grantedBy = "(direct tool)";
      }
    }
    return { toolName: tool.toolName, namespace: tool.namespace, access: tool.access, enabled, grantedBy };
  }).sort((a, b) => a.toolName.localeCompare(b.toolName));

  return { namespaces, tools };
}

export function registerToolRoutes(routes: ReturnType<typeof serve>): void {
  // GET /sessions/:id/tools/resolved — full tool universe annotated with enabled/disabled
  routes.route(sessionsRoutes.getResolvedSessionTools, async (req, res) => {
    try {
      const ps = await getSessionRecord(req.params.sessionId);
      if (!ps) {
        return res.status(404).json({ ok: false, error: "Session not found" });
      }

      const caller = requestCaller(req.authPrincipal);
      const asked = Barry.as(caller);
      const activeBags = ps.bags ?? [];
      const activeBounds = ps.bounds ?? [];
      const [universe, resolvedBound, resolvedTools, availableBoundsList] = await Promise.all([
        collectToolDefinitions(),
        ps.bound ? Promise.resolve(ps.bound as Bound) : Promise.resolve().then(() => asked.bound(ps.identity_id ?? null, activeBounds)),
        Promise.resolve().then(() => asked.tools(ps.identity_id ?? null, activeBags, (ps.bound as Bound | null) ?? activeBounds)),
        Promise.resolve().then(() => asked.bounds(ps.identity_id ?? undefined)).catch(() => []),
      ]);

      const directNamespaces = Array.isArray(ps.metadata?.selected_namespaces)
        ? ps.metadata.selected_namespaces
        : [];
      const directTools = Array.isArray(ps.metadata?.selected_tools)
        ? ps.metadata.selected_tools
        : [];
      const { namespaces, tools } = annotateTools(
        resolvedTools,
        activeBags,
        resolvedBound,
        universe,
        { namespaces: directNamespaces, tools: directTools },
      );

      const availableBags = [...new Set([...universe.map((t) => t.namespace), ...activeBags])].sort();
      const availableBounds = availableBoundsList
        .map((b) => (typeof b.name === "string" ? b.name : ""))
        .filter(Boolean);

      const response: ResolvedToolsResponse = {
        ok: true,
        bags: {
          active: activeBags,
          available: availableBags,
        },
        bounds: activeBounds,
        availableBounds,
        bound: (resolvedBound as Record<string, unknown>) ?? null,
        selectedNamespaces: directNamespaces,
        selectedTools: directTools,
        namespaces,
        tools,
      };

      res.json(response);
    } catch (err) {
      log.error("sessions.tools_resolved_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ ok: false, error: "Failed to resolve tools" });
    }
  });

  // GET /sessions/:id/tools/preview?bags=git,web&bounds=readonly — preview tools for hypothetical bag/bound set
  routes.route(sessionsRoutes.previewSessionTools, async (req, res) => {
    try {
      const ps = await getSessionRecord(req.params.sessionId);
      if (!ps) {
        return res.status(404).json({ ok: false, error: "Session not found" });
      }

      const bagsParam = req.query.bags as string | undefined;
      const boundsParam = req.query.bounds as string | undefined;
      const namespacesParam = req.query.namespaces as string | undefined;
      const toolsParam = req.query.tools as string | undefined;

      const previewBags = bagsParam ? bagsParam.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const previewBounds = boundsParam ? boundsParam.split(",").map((b) => b.trim()).filter(Boolean) : (ps.bounds ?? []);
      const previewNamespaces = namespacesParam ? namespacesParam.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const previewTools = toolsParam ? toolsParam.split(",").map((t) => t.trim()).filter(Boolean) : [];

      if (previewBags.length === 0 && boundsParam === undefined && previewNamespaces.length === 0 && previewTools.length === 0) {
        return res.status(400).json({ ok: false, error: "At least one of bags, bounds, namespaces, or tools query parameter is required" });
      }

      const caller = requestCaller(req.authPrincipal);
      const asked = Barry.as(caller);
      const [universe, resolvedBound, resolvedTools, availableBoundsList] = await Promise.all([
        collectToolDefinitions(),
        Promise.resolve().then(() => asked.bound(ps.identity_id ?? null, previewBounds)),
        Promise.resolve().then(() => asked.tools(ps.identity_id ?? null, previewBags, previewBounds)),
        Promise.resolve().then(() => asked.bounds(ps.identity_id ?? undefined)).catch(() => []),
      ]);
      const { namespaces, tools } = annotateTools(
        resolvedTools,
        previewBags,
        resolvedBound,
        universe,
        { namespaces: previewNamespaces, tools: previewTools },
      );
      const availableBags = [...new Set([...universe.map((t) => t.namespace), ...previewBags])].sort();
      const availableBounds = availableBoundsList
        .map((b) => (typeof b.name === "string" ? b.name : ""))
        .filter(Boolean);

      res.json({
        ok: true,
        bags: {
          active: previewBags,
          available: availableBags,
        },
        bounds: previewBounds,
        availableBounds,
        bound: (resolvedBound as Record<string, unknown>) ?? null,
        selectedNamespaces: previewNamespaces,
        selectedTools: previewTools,
        namespaces,
        tools,
      });
    } catch (err) {
      log.error("sessions.tools_preview_failed", { sessionId: req.params.sessionId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ ok: false, error: "Failed to preview tools" });
    }
  });
}
