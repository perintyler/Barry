import type { Bound } from "@barry-rocks/sdk/bounds";

/**
 * One line naming what a bound actually restricts.
 *
 * A bound's rules are a nested object, and printing it raw is unreadable at a
 * glance. The point of a listing is deciding whether a restriction is the one
 * you want, so summarize the dimensions in play rather than dumping the JSON.
 */
export function summarizeBound(bound: Bound): string {
  const parts: string[] = [];

  if (bound.tools?.allow !== undefined) {
    parts.push(`allow tools: ${bound.tools.allow.length ? bound.tools.allow.join(", ") : "none"}`);
  }
  if (bound.tools?.deny?.length) {
    parts.push(`tools: ${bound.tools.deny.join(", ")}`);
  }

  const inputToolKeys = bound.inputs ? Object.keys(bound.inputs) : [];
  if (inputToolKeys.length) {
    parts.push(`inputs: ${inputToolKeys.length} tool(s)`);
  }

  if (bound.files?.deny?.length) parts.push(`files: ${bound.files.deny.length} pattern(s)`);
  // An empty allowlist is meaningful — it permits nothing — so check for the
  // key's presence rather than its length, same as network.allow below.
  if (bound.files?.allow !== undefined) {
    parts.push(`allow paths: ${bound.files.allow.length || "none"}`);
  }

  if (bound.bash?.allow !== undefined) {
    parts.push(`allow bash: ${bound.bash.allow.length || "none"}`);
  }
  if (bound.bash?.deny?.length) {
    parts.push(`bash: ${bound.bash.deny.length} rule(s)`);
  }

  const net = bound.network;
  if (net?.deny?.length) {
    parts.push(`deny hosts: ${net.deny.length}`);
  }
  // An empty allowlist is meaningful — it permits nothing — so check for the
  // key's presence rather than its length.
  if (net?.allow !== undefined) {
    parts.push(`allow hosts: ${net.allow.length || "none"}`);
  }
  if (net?.enforce) parts.push(`enforce: ${net.enforce}`);

  if (bound.nodes?.allow !== undefined) {
    parts.push(`allow nodes: ${bound.nodes.allow.length ? bound.nodes.allow.join(", ") : "none"}`);
  }
  if (bound.nodes?.deny?.length) {
    parts.push(`deny nodes: ${bound.nodes.deny.join(", ")}`);
  }

  return parts.join(" · ") || EMPTY_BOUND_SUMMARY;
}

/**
 * What an empty bound renders as.
 *
 * Exported because it is a red flag, not a neutral state: every builtin bound
 * defines at least one restriction, so a stored bound that summarizes to this
 * has lost its rules.
 */
export const EMPTY_BOUND_SUMMARY = "(no restrictions)";

