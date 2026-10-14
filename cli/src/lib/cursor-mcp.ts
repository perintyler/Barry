/**
 * Names to prune from an existing mcp.json on setup.
 *
 * Only what Barry wrote last time is eligible: the manifest of previously
 * managed names IS the authority, so a name Barry never wrote is left alone.
 * A hardcoded list of names written before the bags-over-Barry overhaul used
 * to stand in when the manifest was missing, which meant a fresh machine with
 * no manifest could delete a hand-written entry that merely shared a name.
 * With no manifest there is nothing Barry is known to own, so nothing is
 * pruned — the stale entries that list existed for have long since aged out.
 */
export function namesToPrune(
  existingNames: string[],
  nextManagedNames: string[],
  previousManagedNames: string[],
): string[] {
  const next = new Set(nextManagedNames);
  return existingNames.filter(
    (name) => previousManagedNames.includes(name) && !next.has(name),
  );
}
