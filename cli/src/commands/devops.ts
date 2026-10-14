import { PUBLISHABLE_NAMES, DEVOPS_NAMES } from "../command-registry.js";

/**
 * Static CLI command classifications for package boundary checks.
 * Bag command groups are discovered at runtime and excluded from both sets.
 * The sets derive from the registry that also supplies help groups and completion.
 * Boundary tests compare these classifications with the registered command surface.
 */

export const PUBLISHABLE_COMMANDS = new Set(PUBLISHABLE_NAMES);

export const DEVOPS_COMMANDS = new Set(DEVOPS_NAMES);

// ── Bag-generated command groups ───────────────────────────────────────────
// Dynamically registered by registerBagGroups(). These are publishable —
// they're the whole point of the bag CLI bridge. Not listed in the static
// sets above because they're discovered at runtime from ~/.config/barry/cli.yaml.


/**
 * Which commands are not accounted for in exactly one set.
 *
 * Split out from the reporting so a test can assert on the result. The
 * previous version of this check had an empty `if` body with a "silently
 * allow" comment, which meant it accepted every name it was given: 30 static
 * commands were invisible to it, and a healthy boundary looked exactly like a
 * broken one. The set that is supposed to force the package split enforced
 * nothing.
 *
 * `knownBagNames` is what makes the check able to fail. Bag groups are
 * discovered at runtime and legitimately belong to neither set, so without
 * knowing which names those are, "uncategorized" cannot be distinguished from
 * "bag-generated" and the only safe answer is to allow everything — which is
 * how the check died the first time.
 */
export function findBoundaryViolations(
  registeredNames: string[],
  knownBagNames: ReadonlySet<string>,
): { uncategorized: string[]; duplicated: string[] } {
  const uncategorized: string[] = [];
  const duplicated: string[] = [];

  for (const name of registeredNames) {
    if (name === "devops" || name === "identity") continue; // namespaces, not commands in either set
    if (knownBagNames.has(name)) continue; // discovered at runtime; in neither set by design

    const inPublishable = PUBLISHABLE_COMMANDS.has(name);
    const inDevops = DEVOPS_COMMANDS.has(name);

    if (inPublishable && inDevops) duplicated.push(name);
    else if (!inPublishable && !inDevops) uncategorized.push(name);
  }

  return { uncategorized, duplicated };
}
