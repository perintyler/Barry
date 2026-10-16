import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boundFingerprint, approvedBoundsSchema } from "@barry-rocks/sdk/bounds";
import { structuredOutputContract } from "@barry-rocks/sdk/sessions";
import type { JsonSchema } from "@barry-rocks/sdk/ids";
import { composeActionPrompt } from "@barry-rocks/actions-bag";
import { validateActionInputs } from "@barry-rocks/sdk/internal/actions";
import { WorkArtifactStore, WorkflowError, importWorkAgentCatalog, readWorkAgentConfiguration, workAgentCatalogSchema,
  type InstalledWorkAgent, type WorkAuthority, type WorkResolution, type WorkSubmission, type WorkflowArtifact, type WorkArtifactRef } from "@barry-rocks/sdk/internal/workflows";

/** Private same-host catalog import. This is code custody, not caller authority. */
export function installedCommonAgents(path: string, artifacts: WorkArtifactStore, installation: string) {
  const catalog = workAgentCatalogSchema.parse(readWorkAgentConfiguration(path));
  if (catalog.installation !== installation) throw new WorkflowError("WorkAgentInstallationMismatch", "Installed agent catalog belongs to another installation.", 503);
  const source = new WorkArtifactStore(catalog.artifact_root, 256 * 1024 * 1024);
  try { return { catalog, agents: importWorkAgentCatalog(catalog, source, artifacts), catalogSource: artifacts.stage(Buffer.from(JSON.stringify(catalog)), { purpose: "source", owner_identity: null, media_type: "application/vnd.barry.agent-deployment+json" }) }; }
  finally { source.close(); }
}
export const commonAgentScope = (reference: string) => `agents:${boundFingerprint({ reference })}@1`;
export const commonAgentType = (agent: InstalledWorkAgent) => `agents:${agent.source.digest}@1`;
export function agentArchive(agents: InstalledWorkAgent[], artifacts: WorkArtifactStore, abi: WorkflowArtifact["abi"]): WorkflowArtifact[] {
  return agents.map(agent => ({ type: commonAgentType(agent), version: "activity", digest: agent.source.digest, path: artifacts.path(agent.source), abi, kind: "program", bytes: agent.source.bytes }));
}
export async function resolveCommonAgent(agent: InstalledWorkAgent, request: WorkSubmission, authority: WorkAuthority,
  installation: string, workflow: WorkflowArtifact, wrapper: WorkArtifactRef, broker: string, deployment: WorkArtifactRef): Promise<WorkResolution> {
  const profile = agent.profile, original = authority.caller_ceiling, bound = original.bound;
  // A worker credential and code profile do not confer an identity or tools.
  if (authority.namespace.principal_kind !== "identity" || !authority.namespace.identity_id
    || original.identity !== authority.namespace.identity_id || original.harness && original.harness !== profile.harness
    || bound?.files || bound?.bash || bound?.network
    || bound?.nodes?.deny?.some(id => id === "local" || id === installation)
    || bound?.nodes?.allow && !bound.nodes.allow.some(id => id === "local" || id === installation))
    throw new WorkflowError("WorkAgentScopeUnsupported", "The installed tool-free Sessions profile cannot enforce the selected authority.", 409);
  const inputs = z.record(z.string(), z.json()).parse(request.inputs);
  const invalid = validateActionInputs({ name: profile.title, inputSchema: profile.input_schema }, inputs);
  if (invalid.length) throw new WorkflowError("InvalidInputs", invalid.join(" "), 422, false, "not-accepted");
  const composed = await composeActionPrompt({ dir: profile.cwd.path, instructions: [], inputSchema: profile.input_schema, prompt: profile.prompt }, inputs, async () => null);
  // Input is retained in the accepted workflow envelope. No model call occurs in admission.
  const evidence = { identity: original.identity, bags: [], traits: [], bound: original.bound, harness: profile.harness, tools: {}, contracts: {} };
  const scope = approvedBoundsSchema.parse({ ...evidence, fingerprint: boundFingerprint(evidence) });
  const grant = { version: 2 as const, grant_ref: `grant_${randomUUID()}`, revision: 1, namespace: authority.namespace,
    authorizer: authority.namespace.principal_id, created_by: authority.namespace.principal_id, approved_at: Date.now(), original_caller_ceiling: original,
    effective_scope: scope, definition_bounds_digest: boundFingerprint(profile), policy_revision: "installed-tool-free-agent-v1" };
  const prompt = profile.validation.mode === "json-schema" && profile.validation.schema.type !== "string" ? `${composed.prompt}\n${structuredOutputContract(profile.validation.schema as JsonSchema)}` : composed.prompt;
  const type = commonAgentType(agent), input = { activity_type: type, input: { prompt }, execution_budget_ms: profile.execution_budget_ms };
  return { grant, title: profile.title, workflow_input: input, plan: {
    version: 2, definition: request.definition, workflow: { type: workflow.type, version: workflow.version, artifact_digest: workflow.digest, runtime_abi: workflow.abi, input_digest: boundFingerprint(input) },
    source_closure: [wrapper, deployment, ...agent.sources], grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "work-v2", execution_profile: "portable",
    effect_policy: { class: "non-repeatable", max_attempts: 1 }, validation: profile.validation,
    agent_program: { activity_type: type, source_digest: agent.source.digest, installation, scope, profile: agent.source },
    resources: { executor: "agent", lane: authority.origin.trigger === "schedule" ? "scheduled" : authority.origin.trigger === "internal" ? "internal" : "unscheduled", logical_reservation: "owner-assigned", host_reservation: null,
      endpoint: { broker, endpoint: profile.endpoint_resource, reservation: null, model: profile.model, max_input_tokens: profile.max_input_tokens, max_output_tokens: profile.max_output_tokens, max_cost: profile.max_cost } },
    workspace: { kind: "host-bound", installation, resource_ref: boundFingerprint(profile.cwd), mapping_version: 1 },
    selection: { requested_model: profile.model, resolved_model: profile.model, endpoint: profile.endpoint, requested_harness: profile.harness, resolved_harness: profile.harness, provenance: "definition" },
    execution_budget_ms: profile.execution_budget_ms, dispatch_budget_ms: 120000,
  } };
}
