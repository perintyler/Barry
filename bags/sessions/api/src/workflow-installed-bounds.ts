/** Data retained by Sessions; credentials and executable provider factories never enter it. */
import { boundFingerprint, boundHasContent, resolveNativeTools, type Bound, type NativeHarness } from "@barry-rocks/sdk/bounds";
import type { Vendor } from "@barry-rocks/sdk/adapters/models";
import type { BagToolInput, Tool } from "@barry-rocks/sdk";
import type { ModeId } from "@barry-rocks/sdk/ids";
import { requiredIdentityBags } from "@barry-rocks/sdk/internal/identities";
import { identityRecords, resolve } from "@barry-rocks/identities-bag";
import { selectionOf } from "@barry-rocks/sessions-bag";
import type { getSession } from "@barry-rocks/sessions-bag/client";

type Origin = NonNullable<Awaited<ReturnType<typeof getSession>>>;
export function immutableWorkflowOrigin(row: Origin): string {
  return boundFingerprint({ id: row.id, user_id: row.user_id, identity_id: row.identity_id,
    selection: selectionOf(row), workflow_bound: row.metadata.workflow_bound,
    workflow_identity_id: row.metadata.workflow_identity_id, execution_context: row.metadata.execution_context,
    source: row.metadata.source });
}

function providerData(vendor: Vendor): Vendor {
  // Static provider factories are not invoked by this profile. The retained
  // harness supplies the protocol implementation; catalog discovery cannot
  // silently add a model or redirect an accepted request.
  if (vendor.listModels) throw new Error("WorkflowProviderDynamicCatalogUnsupported");
  return JSON.parse(JSON.stringify({ id: vendor.id, label: vendor.label, baseUrl: vendor.baseUrl,
    compatible: vendor.compatible, credential: vendor.credential, models: vendor.models })) as Vendor;
}
export interface FrozenWorkflowProvider {
  version: 1; vendor: Vendor; model: string; endpoint: string; credentialNames: string[]; fingerprint: string;
}
export function freezeWorkflowProvider(vendor: Vendor, model: string, endpoint: string): FrozenWorkflowProvider {
  const retained = providerData(vendor), selected = retained.models.filter(item => item.id === model);
  if (selected.length !== 1 || selected[0]!.kind !== "completion") throw new Error("WorkflowProviderModelUnavailable");
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("WorkflowProviderEndpointUnsupported");
  const credentialNames = retained.credential && "env" in retained.credential ? [retained.credential.env] : [];
  const evidence = { version: 1 as const, vendor: retained, model, endpoint, credentialNames };
  return { ...evidence, fingerprint: boundFingerprint(evidence) };
}
export function assertWorkflowProviderCurrent(frozen: FrozenWorkflowProvider, current: Vendor): void {
  const retained = freezeWorkflowProvider(frozen.vendor, frozen.model, frozen.endpoint);
  if (frozen.version !== retained.version || retained.fingerprint !== frozen.fingerprint
    || boundFingerprint(frozen.credentialNames) !== boundFingerprint(retained.credentialNames)) throw new Error("WorkflowProviderSelectionChanged");
  const rebuilt = freezeWorkflowProvider(current, frozen.model, frozen.endpoint);
  if (rebuilt.fingerprint !== frozen.fingerprint) throw new Error("WorkflowProviderSelectionChanged");
}

type NativeBounds = { bound: Bound | null | undefined; tools: readonly Tool[] };
export function workflowNativeCeiling(parent: NativeBounds, selected: NativeBounds, adapter: NativeHarness): { allowed: string[]; denied: string[] } {
  const original = resolveNativeTools({ bound: parent.bound ?? null, tools: parent.tools }, adapter, "hosted");
  const requested = resolveNativeTools({ bound: selected.bound ?? null, tools: selected.tools }, adapter, "hosted");
  const enforceable = (resolution: ReturnType<typeof resolveNativeTools>) => {
    if (Object.keys(resolution.uncontrolled).length || Object.keys(resolution.conflicts).length) throw new Error("WorkflowNativePolicyUnsupported");
  };
  enforceable(original);enforceable(requested);
  const access = (boundsEntry: NativeBounds, name: string) => boundsEntry.tools.find(tool => tool.bag === null && tool.namespace === adapter.id && tool.name === name && !tool.unavailable && !tool.uncontrolled)?.access;
  const allowed = requested.allowed.filter(name => original.allowed.includes(name)
    && !(access(parent, name) === "read" && access(selected, name) === "write"));
  // Recompute native control for the intersection, so inseparable groups stay
  // all-or-nothing even when each bound separately allowed a different set.
  const combined = resolveNativeTools({ bound: selected.bound ?? null, tools: selected.tools.filter(tool => allowed.includes(tool.name)) }, adapter, "hosted");
  enforceable(combined);
  return { allowed: combined.allowed, denied: [...(adapter.tools ?? [])].filter(name => !combined.allowed.includes(name)) };
}

export interface WorkflowSessionSelection {
  readonly bags?: readonly string[];
  readonly traits?: readonly string[];
  readonly bounds?: readonly (Bound | string)[];
  readonly bound?: Bound | null;
  readonly harness?: string;
  readonly mode?: ModeId;
  readonly defaults?: boolean;
  readonly identityDefaults?: boolean;
  readonly namespaces?: readonly string[];
  readonly tools?: readonly (string | BagToolInput)[];
}

function stripReadSuffix(name: string): string {
  return name.endsWith(":read")
    ? name.slice(0, -":read".length)
    : name.endsWith("-readonly")
      ? name.slice(0, -"-readonly".length)
      : name;
}

export async function resolveWorkflowSessionBounds(
  identityId: number,
  selection: WorkflowSessionSelection,
  catalogTools?: readonly BagToolInput[],
): Promise<{
  bags: string[];
  traits: string[];
  bound: Bound | null;
  tools: Tool[];
  skills: { name: string }[];
  instructions: { name: string }[];
}> {
  const identity = await identityRecords.row(identityId);
  if (!identity) throw new Error(`unknown session identity id ${identityId}`);
  const config = identityRecords.config(identity);
  const identityDefaults = selection.identityDefaults !== false;
  const rawExplicitBags = selection.bags ?? selection.traits ?? [];
  const hasExplicitIdentityBags = Array.isArray(identity.metadata?.bags);
  const allowedIdentityBags = hasExplicitIdentityBags
    ? new Set((config.bags ?? []).map(stripReadSuffix))
    : null;
  const explicitBags = allowedIdentityBags
    ? rawExplicitBags.filter((bag) => allowedIdentityBags.has(stripReadSuffix(bag)))
    : rawExplicitBags;
  const explicitNamespaces = allowedIdentityBags
    ? (selection.namespaces ?? []).filter((ns) => allowedIdentityBags.has(stripReadSuffix(ns)))
    : (selection.namespaces ?? []);
  const identityBagNames = identityDefaults
    ? requiredIdentityBags(config.bags ?? [], config.bag_configs ?? {}).map(stripReadSuffix)
    : [];
  const activeBags = [
    ...new Set([
      ...identityBagNames,
      ...explicitBags.map(stripReadSuffix),
      ...explicitNamespaces,
    ]),
  ];
  const combinedBounds: (Bound | string)[] = [
    ...(selection.bounds ?? []),
    ...(selection.bound ? [selection.bound] : []),
  ];
  const resolvedBound = await resolve.bound(identity, {
    bags: explicitBags,
    bounds: combinedBounds,
    ...(selection.harness ? { harness: selection.harness } : {}),
    ...(selection.mode ? { mode: selection.mode } : {}),
    defaults: false,
    identityDefaults: true,
  });
  const bound = boundHasContent(resolvedBound) ? resolvedBound : null;
  const rawTools = await resolve.tools(identity, {
    bags: [...explicitBags, ...explicitNamespaces],
    bound: resolvedBound,
    ...(selection.harness ? { harness: selection.harness } : {}),
    ...(selection.mode ? { mode: selection.mode } : {}),
    defaults: false,
    identityDefaults,
    ...(catalogTools !== undefined ? { tools: catalogTools } : {}),
  });
  const includeNativeTools =
    selection.defaults !== false ||
    (selection.harness !== undefined && activeBags.includes(selection.harness));
  const tools = includeNativeTools ? rawTools : rawTools.filter((tool) => tool.bag !== null);
  return {
    bags: activeBags,
    traits: activeBags,
    bound,
    tools,
    skills: [],
    instructions: [],
  };
}

