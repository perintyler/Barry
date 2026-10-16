/** Relocation-independent installed declarations checked inside retained code. */
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkAdapter, type Adapter, type InstalledAdapter, type Mode } from "@barry-rocks/sdk/adapters/harnesses";
import { decodeManifestYaml, parseManifestObject } from "@barry-rocks/sdk/bags";
import { readBoundedFile } from "@barry-rocks/sdk/internal/workflows";
import { canonicalWorkflowHarnessJson } from "./workflow-harness-protocol.js";

function modes(value: Adapter["modes"] | InstalledAdapter["modes"]) {
  return Object.fromEntries((["hosted", "instrumented", "guest"] as const).map(slot => {
    const mode = value[slot] as Mode | null;
    return [slot, mode ? {
      guarantees: mode.guarantees, verifiedOn: mode.verifiedOn, evidence: mode.evidence, egressSandbox: mode.egressSandbox,
      ...(mode.native ? { native: mode.native } : {}),
      ...(mode.approvalContinuation ? { approvalContinuation: mode.approvalContinuation } : {}),
      ...(mode.platforms ? { platforms: mode.platforms } : {}),
      ...(mode.attachesTo ? { attachesTo: mode.attachesTo } : {}),
    } : null];
  }));
}

function requirements(value: Adapter["requirements"] | InstalledAdapter["requirements"]) {
  const binary = { ...value.binary } as Record<string, unknown> & { recommendedVersion?: string; pin?: { version: string } };
  binary.recommendedVersion ??= binary.pin?.version;
  delete binary.pin;
  return { ...value, binary };
}

function declaration(adapter: Adapter | InstalledAdapter, bag: unknown) {
  const value = {
    id: adapter.id, label: adapter.label, requirements: requirements(adapter.requirements), capabilities: adapter.capabilities,
    tools: adapter.tools, defaultMode: adapter.defaultMode, modes: modes(adapter.modes),
    ...(adapter.aliases?.length ? { aliases: adapter.aliases } : {}),
    ...(adapter.experimental !== undefined ? { experimental: adapter.experimental } : {}),
    ...(adapter.vendor ? { vendor: adapter.vendor } : {}),
    ...(adapter.offeredModels ? { offeredModels: adapter.offeredModels } : {}),
    ...(bag ? { bag } : {}),
  };
  // The installed loader serializes normalized optional manifest fields in
  // precisely this way. No relocation-specific path is introduced here.
  return JSON.parse(canonicalWorkflowHarnessJson(JSON.parse(JSON.stringify(value)))) as unknown;
}

export function installedWorkflowDeclaration(record: InstalledAdapter): unknown {
  // Paths and installedAt identify selection, separately; they cannot identify
  // executable bytes. Bag paths never cross into a relocated worker.
  return declaration(record, record.bag?.manifest);
}

export function retainedWorkflowDeclaration(adapter: Adapter, module: string): unknown {
  if (!adapter || typeof adapter !== "object") throw new Error("WorkflowRuntimeAdapterUnavailable");
  let bag: ReturnType<typeof parseManifestObject> | undefined;
  if (adapter.bag !== undefined) {
    if (typeof adapter.bag !== "string" || isAbsolute(adapter.bag)) throw new Error("WorkflowRuntimeBagUnavailable");
    // The adapter entry may be under dist/. Find its captured package, never
    // an ambient package or original registry path.
    let root = dirname(fileURLToPath(module));
    while (!root.match(/[/\\]packages[/\\]p[0-9]+$/)) {
      if (dirname(root) === root) throw new Error("WorkflowRuntimeBagUnavailable");
      root = dirname(root);
    }
    const directory = realpathSync(resolve(root, adapter.bag)), child = relative(root, directory);
    if (child === ".." || child.startsWith("../") || isAbsolute(child)) throw new Error("WorkflowRuntimeBagUnavailable");
    const raw = decodeManifestYaml(readBoundedFile(join(directory, "bag.yaml"), 4_194_304).toString("utf8"));
    const allowed = new Set(["name", "description", "credentials", "bounds"]);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.has(key))) throw new Error("WorkflowRuntimeBagProfileUnsupported");
    const check = (value: unknown, depth = 0): void => {
      if (depth > 64) throw new Error("WorkflowRuntimeBagProfileUnsupported");
      if (!value || typeof value !== "object") return;
      if (Object.hasOwn(value, "constant")) throw new Error("WorkflowRuntimeBagProfileUnsupported");
      for (const child of Object.values(value)) check(child, depth + 1);
    };
    check(raw);
    // No ambient bag resolver, implicit tools.ts discovery, composed constants,
    // services, providers, scripts or schedules exist in this explicit profile.
    bag = parseManifestObject(raw, "retained adapter manifest");
  }
  const checked = checkAdapter(adapter, { bagManifest: bag ?? undefined });
  if (!checked.checked || checked.problems.length || adapter.modes.hosted?.approvalContinuation !== "durable"
    || typeof adapter.modes.hosted.openContinuation !== "function") throw new Error("WorkflowRuntimeAdapterContractUnavailable");
  return declaration(adapter, bag);
}
