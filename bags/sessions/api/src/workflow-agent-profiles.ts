/** Publish explicitly installed prompt actions into immutable Work code custody. */
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseModelRef } from "@barry-rocks/sdk/ids";
import { installedModels } from "@barry-rocks/sdk/adapters/models";
import { loadAllBags } from "@barry-rocks/sdk/internal/bags";
import { listAllActions } from "@barry-rocks/sdk/internal/actions";
import { readWorkAgentConfiguration, workAgentCatalogSchema, workAgentProfileSchema, type WorkAgentCatalog } from "@barry-rocks/sdk/internal/workflows";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { workflowRuntimeArtifacts } from "./workflow-runtime-closure.js";
import { freezeWorkflowProvider } from "./workflow-installed-bounds.js";
import type { InstalledWorkflowRuntimeInstallation } from "./workflow-runtime-installation.js";

const absolute = z.string().max(4096).refine(isAbsolute);
const configuration = z.strictObject({ version: z.literal(1), catalog: absolute, worker_id: z.uuid(),
  endpoint_broker: workAgentCatalogSchema.shape.endpoint_broker,
  actions: z.array(z.strictObject({ reference: z.string().min(1).max(200), harness: z.literal("pi"), model: z.string().min(1).max(200), cwd: absolute,
    budget_policy: z.literal("reservation-only"), endpoint_resource: z.string().min(1).max(200), max_input_tokens: z.number().int().positive(), max_cost: z.number().finite().nonnegative() })).min(1).max(100),
});
function publish(path: string, catalog: WorkAgentCatalog): void {
  const directory = dirname(path); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (realpathSync(directory) !== directory || !info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new Error("WorkAgentCatalogDirectoryUnavailable");
  const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(catalog)); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) { try { unlinkSync(temporary); } catch { /* Preserve original publication error. */ } throw error; }
}
/** Only static, self-contained, tool-free prompt definitions are eligible in
 * this profile. Unsupported contracts remain on their existing producer path. */
export async function publishWorkflowAgentProfiles(path: string, installation: InstalledWorkflowRuntimeInstallation): Promise<WorkAgentCatalog> {
  const selected = configuration.parse(readWorkAgentConfiguration(path)), node = installationRegistry().id;
  const actions = await listAllActions(await loadAllBags());
  const profiles = selected.actions.map(item => {
    const action = actions.find(action => action.qualifiedName === item.reference), registration = installation.registry.current(item.harness);
    const retained = registration && installation.registry.descriptor(registration.generation);
    if (!action || action.prompt === undefined || action.run !== undefined || action.job !== undefined || !registration || !retained
      || action.instructions.length || action.steps.length || action.preflight || action.validate || action.context !== "none"
      || action.requires.tools.length || action.requires.bins.length || action.requires.secrets.length
      || action.agent?.agent && action.agent.agent !== item.harness || action.agent?.model && action.agent.model !== item.model
      || retained.record.id !== "pi" || retained.record.vendor || retained.record.vendorCode || retained.record.capabilities.toolDenial !== "native"
      || retained.record.capabilities.endpoint !== "configurable" || retained.record.modes.hosted?.approvalContinuation !== "durable" || retained.record.modes.hosted.guarantees.gating !== "per-call" || Object.keys(retained.record.modes.hosted?.native?.uncontrolled ?? {}).length)
      throw new Error("WorkAgentDefinitionUnsupported");
    const ref = parseModelRef(item.model), vendor = ref && installedModels().vendors().find(vendor => vendor.id === ref.vendor);
    if (!ref || !vendor || typeof vendor.baseUrl !== "string") throw new Error("WorkAgentProviderUnavailable");
    const provider = freezeWorkflowProvider(vendor, ref.model, vendor.baseUrl);
    const cwd = realpathSync(item.cwd), info = statSync(cwd);
    if (cwd !== item.cwd || !info.isDirectory()) throw new Error("WorkAgentWorkspaceUnavailable");
    const profile = workAgentProfileSchema.parse({ version: 1, installation: node, reference: action.qualifiedName, title: action.name,
      harness: item.harness, model: item.model, endpoint: provider.endpoint, provider, generation: registration.generation, record_hash: registration.recordHash,
      runtime: registration.runtime, cwd: { path: cwd, device: info.dev, inode: info.ino }, prompt: action.prompt, max_turns: 1,
      ...(action.inputSchema ? { input_schema: action.inputSchema } : {}), validation: action.outputSchema ? { mode: "json-schema", schema: action.outputSchema } : { mode: "none" },
      execution_budget_ms: (action.timeout ?? 600) * 1000, budget_policy: item.budget_policy, endpoint_resource: item.endpoint_resource, max_input_tokens: item.max_input_tokens,
      max_output_tokens: 4096, max_cost: item.max_cost, sources: workflowRuntimeArtifacts(installation.artifacts, registration.runtime) });
    const source = installation.artifacts.stage(Buffer.from(JSON.stringify(profile)), { purpose: "source", owner_identity: null, media_type: "application/vnd.barry.agent-profile+json" });
    installation.artifacts.retainExecutor(source); return source;
  });
  const catalog = workAgentCatalogSchema.parse({ version: 1, installation: node, worker_id: selected.worker_id, artifact_root: installation.artifacts.root, endpoint_broker: selected.endpoint_broker, profiles });
  publish(selected.catalog, catalog); return catalog;
}
