/**
 * Bag capability requirements — `requires:` in bag.yaml.
 *
 * A requirement is the third kind of dependency a bag can declare, distinct
 * from the two that already exist:
 *
 * - `dependencies:` — host binaries, checked with isBinaryOnPath.
 * - `bags:`       — composition: pull another bag's tools in wholesale.
 * - `requires:`     — another bag's capability that this bag CALLS but
 *                     does not absorb. You do not get its tools; you get a
 *                     registered bag.
 *
 * Checked at bag LOAD time by the three tool-loading hosts (MCP server,
 * bag CLI, Slack server), which already have a skip-and-log failure path —
 * an unmet non-optional requirement drops the bag's tools with one clear
 * line instead of surfacing a confusing error mid-tool-call. Never re-checked
 * per call.
 */

import { getBagSource } from "./registry.js";
import { resolveBagAccess } from "./types.js";
import type { Bag, BagRequirement } from "./types.js";

export interface MissingRequirement {
  /** The requiring bag. */
  bag: string;
  /** The required bag. */
  target: string;
  reason?: string;
  optional: boolean;
  /** Human-readable diagnosis, incl. the manifest's `reason` when declared. */
  message: string;
}

export interface RequirementCheckContext {
  /** Is a bag registered and not disabled? Defaults to the real registry. */
  isBagAvailable?: (name: string) => boolean;
}

function defaultIsBagAvailable(name: string): boolean {
  const source = getBagSource(name);
  return !!source && resolveBagAccess(source) !== "disabled";
}

/**
 * Check one bag's declared requirements. Returns every unmet requirement —
 * including optional ones, with `optional` set, so callers decide whether an
 * unmet-optional is a warning or nothing at all.
 */
export function checkBagRequirements(
  bag: Bag,
  ctx: RequirementCheckContext = {},
): MissingRequirement[] {
  if (!bag.requires.length) return [];

  const isAvailable = ctx.isBagAvailable ?? defaultIsBagAvailable;
  const missing: MissingRequirement[] = [];

  const report = (req: BagRequirement & { target: string }, detail: string) => {
    const reason = req.reason ? ` (needed: ${req.reason})` : "";
    missing.push({
      bag: bag.name,
      target: req.target,
      ...(req.reason !== undefined ? { reason: req.reason } : {}),
      optional: req.optional ?? false,
      message: `${bag.name} requires ${req.target}: ${detail}${reason}`,
    });
  };

  for (const req of bag.requires) {
    if (!isAvailable(req.target)) {
      report(req, "bag is not registered or is disabled — add it with `barry install`");
    }
  }

  return missing;
}

/**
 * The packed bags that require `target` and would lose their tools without it.
 *
 * `unpack` asks this first: taking a bag off an identity while another packed
 * bag still `requires:` it strands that bag, which loads with its tools dropped
 * and says so only in a log. An optional requirement does not count.
 */
export function packedBagsRequiring(
  target: string,
  packed: readonly { name: string; manifest?: { requires?: Record<string, BagRequirement> } | null }[],
): string[] {
  return packed
    .filter((bag) => bag.name !== target)
    .filter((bag) => {
      const requirement = bag.manifest?.requires?.[target];
      return requirement !== undefined && !requirement.optional;
    })
    .map((bag) => bag.name);
}
