/**
 * Which agent and model a detached action run executes on.
 *
 * Four sources can have an opinion, and before this they were resolved ad hoc
 * at the one call site that cared: the executor honored `action.model` only
 * when the request named no provider, and nothing else was consulted at all.
 * That rule was right but invisible, and the identity tier was simply missing.
 *
 * Precedence, highest first, resolved PER FIELD:
 *
 *   request   — an explicit `provider`/`model` on the run request
 *   manifest  — the action's `agent:` block
 *   identity  — the identity's adapters for the winning agent
 *   default   — the agent's own default (expressed as an absent model)
 *
 * A manifest's model belongs to its agent and does not follow a request that
 * switches agents. The identity instead provides settings per agent, so its
 * model for the winning agent applies however that agent was selected.
 *
 * Returning the tier per field is not decoration. "The manifest asked for
 * opus and got it" and "the manifest asked for opus and was overridden" are
 * different facts, and a run row that cannot tell them apart makes a
 * preference that silently did not apply look like one that did.
 */

/** Where a resolved value came from. */
export type AgentTier = "request" | "manifest" | "identity" | "default";

export interface AgentResolutionInput {
  /** Explicit request overrides, if the caller sent any. */
  request?: { agent?: string | undefined; model?: string | undefined };
  /** The action manifest's `agent:` block. */
  manifest?: { agent?: string | undefined; model?: string | undefined };
  /** The barry's defaults. Absent on unattributed triggers. */
  identity?: { agent?: string | undefined; modelFor?(agent: string): string | undefined };
  /** Agent used when nobody names one. */
  fallbackAgent: string;
}

export interface AgentResolution {
  agent: string;
  /** Absent means "pass no model flag and let the agent's CLI decide". */
  model: string | undefined;
  agentFrom: AgentTier;
  modelFrom: AgentTier;
}

export function resolveRunAgent(input: AgentResolutionInput): AgentResolution {
  const { request, manifest, identity, fallbackAgent } = input;

  const agentTier: AgentTier = request?.agent
    ? "request"
    : manifest?.agent
      ? "manifest"
      : identity?.agent
        ? "identity"
        : "default";

  const agent =
    request?.agent ?? manifest?.agent ?? identity?.agent ?? fallbackAgent;

  // The carrier rule. A tier's model is usable only if that tier either chose
  // the winning agent or expressed no opinion about the agent at all; a tier
  // that named a DIFFERENT agent picked its model for that other agent's space.
  const carries = (tier?: { agent?: string | undefined }): boolean =>
    !tier?.agent || tier.agent === agent;

  let model: string | undefined;
  let modelFrom: AgentTier = "default";
  if (request?.model && carries(request)) {
    model = request.model;
    modelFrom = "request";
  } else if (manifest?.model && carries(manifest)) {
    model = manifest.model;
    modelFrom = "manifest";
  } else if (identity?.modelFor?.(agent)) {
    model = identity.modelFor(agent);
    modelFrom = "identity";
  }

  return { agent, model, agentFrom: agentTier, modelFrom };
}
