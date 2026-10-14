// Resolved/preview tool routes for the sessions lifecycle router, plus the
// trait-merge helper. Extracted verbatim from session-lifecycle.ts for file
// size; no behavior change.
import { traits, type TraitInfo } from "@barry-rocks/identities-bag";
import { Barry, requestCaller, type Grants } from "@barry-rocks/sdk";
import { createLogger } from "@barry-rocks/sdk/logging";
import { sessionsRoutes } from "@barry-rocks/sdk/internal/routes";
import type { serve } from "@barry-rocks/sdk/services/http";
import { selectionOf, sessionGrants } from "@barry-rocks/sessions-bag";
import { qualifyToolId } from "@barry-rocks/sdk/bounds";
import { collectToolMeta, type ToolMetaEntry } from "@barry-rocks/sdk/internal/tools";
import { getSessionRecord } from "../db.js";

const log = createLogger("barry-server");

export function mergeActiveIntoSelectable(
  selectable: TraitInfo[],
  all: TraitInfo[],
  activeNames: string[],
): TraitInfo[] {
  if (activeNames.length === 0) return selectable;
  const present = new Set(selectable.map((t) => t.name));
  const missing = activeNames
    .filter((name) => !present.has(name))
    .map((name) => all.find((t) => t.name === name))
    .filter((t): t is NonNullable<typeof t> => t !== undefined);
  return missing.length > 0 ? [...selectable, ...missing] : selectable;
}

interface ResolvedToolsResponse {
  ok: true;
  traits: {
    active: string[];
    available: Array<{ name: string; description: string | null; access: string; namespaces: string[] }>;
  };
  /** Namespaces directly selected (additive, independent of traits) */
  selectedNamespaces: string[];
  /** Tools directly selected (additive, independent of traits) */
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
 * Every tool a bag declares, marked with whether `grants` reaches it and what
 * granted it: the first of the granted traits naming its namespace, else a
 * direct pick.
 */
function annotateTools(
  grants: Grants,
  universe: readonly ToolMetaEntry[],
  allTraits: readonly TraitInfo[],
  direct: { namespaces: readonly string[]; tools: readonly string[] },
): Pick<ResolvedToolsResponse, "namespaces" | "tools"> {
  const traitsByName = new Map(allTraits.map((trait) => [trait.name, trait]));
  const granting = grants.traits.flatMap((name) => traitsByName.get(name) ?? []);
  const grantersOf = (namespace: string) => granting.filter((trait) => trait.namespaces.includes(namespace)).map((trait) => trait.name);
  const enabledNamespaces = new Set(grants.namespaces);
  const enabledTools = new Set(grants.tools.map((tool) => qualifyToolId(tool.namespace, tool.name)));

  const toolCounts = new Map<string, number>();
  for (const tool of universe) toolCounts.set(tool.namespace, (toolCounts.get(tool.namespace) ?? 0) + 1);
  const namespaces = [...toolCounts.entries()]
    .map(([name, toolCount]) => {
      const enabled = enabledNamespaces.has(name);
      return { name, enabled, grantedBy: enabled ? grantersOf(name) : [], toolCount };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const tools = universe.map((tool) => {
    const enabled = enabledTools.has(qualifyToolId(tool.namespace, tool.toolName));
    let grantedBy: string | null = null;
    if (enabled) {
      grantedBy = grantersOf(tool.namespace)[0] ?? null;
      if (!grantedBy) {
        if (direct.namespaces.includes(tool.namespace)) grantedBy = "(direct namespace)";
        if (direct.tools.includes(tool.toolName)) grantedBy = "(direct tool)";
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

    // `allTraitsList` stays unfiltered so an active trait from a since-removed
    // bag still resolves; `selectableTraits` is the narrowed menu (see
    // traits.selectable).
    const [allTraitsList, selectableTraits, universe, granted] = await Promise.all([
      traits.list(),
      traits.selectable(ps.identity_id),
      collectToolMeta(),
      sessionGrants(ps.id, requestCaller(req.authPrincipal)),
    ]);

    const activeTraits = ps.traits || [];
    // Direct picks from session metadata, which its grants already include.
    const directNamespaces = Array.isArray(ps.metadata?.selected_namespaces)
      ? ps.metadata.selected_namespaces
      : [];
    const directTools = Array.isArray(ps.metadata?.selected_tools)
      ? ps.metadata.selected_tools
      : [];
    const { namespaces, tools } = annotateTools(granted, universe, allTraitsList, { namespaces: directNamespaces, tools: directTools });

    const response: ResolvedToolsResponse = {
      ok: true,
      traits: {
        active: activeTraits,
        // Selectable traits, plus any the session already has. A trait can go
        // stale while a session holds it; it stays listed so the UI can render
        // it as checked and let the user turn it off, instead of showing an
        // active trait that appears nowhere in the list.
        available: mergeActiveIntoSelectable(selectableTraits, allTraitsList, activeTraits).map((t) => ({
          name: t.name,
          description: t.description,
          access: t.access,
      includes: t.includes,
      harnessTraits: t.harnessTraits,
      bound: t.bound,
      boundNames: t.boundNames,
          namespaces: t.namespaces,
        })),
      },
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

// GET /sessions/:id/tools/preview?traits=core,web — preview tools for hypothetical trait set
routes.route(sessionsRoutes.previewSessionTools, async (req, res) => {
  try {
    const ps = await getSessionRecord(req.params.sessionId);
    if (!ps) {
      return res.status(404).json({ ok: false, error: "Session not found" });
    }

    const traitsParam = req.query.traits as string | undefined;
    const namespacesParam = req.query.namespaces as string | undefined;
    const toolsParam = req.query.tools as string | undefined;

    const previewTraits = traitsParam ? traitsParam.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const previewNamespaces = namespacesParam ? namespacesParam.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const previewTools = toolsParam ? toolsParam.split(",").map((t) => t.trim()).filter(Boolean) : [];

    if (previewTraits.length === 0 && previewNamespaces.length === 0 && previewTools.length === 0) {
      return res.status(400).json({ ok: false, error: "At least one of traits, namespaces, or tools query parameter is required" });
    }

    // The session as it is, with the previewed selection in place of its own.
    const selection = { ...selectionOf(ps), traits: previewTraits, namespaces: previewNamespaces, tools: previewTools };
    const asked = Barry.as(requestCaller(req.authPrincipal));
    // Unfiltered list so a previewed trait always resolves; narrowed list for
    // the menu (see traits.selectable).
    const [allTraitsList, selectableTraits, universe, granted] = await Promise.all([
      traits.list(),
      traits.selectable(ps.identity_id),
      collectToolMeta(),
      ps.identity_id === null ? asked.grants(selection) : asked.identity(ps.identity_id).grants(selection),
    ]);
    const { namespaces, tools } = annotateTools(granted, universe, allTraitsList, { namespaces: previewNamespaces, tools: previewTools });

    res.json({
      ok: true,
      traits: {
        active: previewTraits,
        available: mergeActiveIntoSelectable(selectableTraits, allTraitsList, previewTraits).map((t) => ({
          name: t.name,
          description: t.description,
          access: t.access,
      includes: t.includes,
      harnessTraits: t.harnessTraits,
      bound: t.bound,
      boundNames: t.boundNames,
          namespaces: t.namespaces,
        })),
      },
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
