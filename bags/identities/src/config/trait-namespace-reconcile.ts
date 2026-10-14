/** Preserve curated namespaces provided by any loaded bag and prune only those absent from the complete provider set; see docs/decisions/0013-session-store-and-mcp-admission.md. */

export interface TraitNamespaceReconciliation {
  /** The namespace list to persist. */
  namespaces: string[];
  /**
   * Stored namespaces absent from the derivation but still provided by some
   * bag — curated cross-bag grants that were preserved.
   */
  kept: string[];
  /**
   * Stored namespaces absent from the derivation and provided by no bag —
   * dead references that were dropped.
   */
  pruned: string[];
}

export interface ReconcileTraitNamespacesInput {
  /** Namespaces currently stored on the trait row. */
  stored: readonly string[];
  /** Namespaces the bag manifests derive for this trait. */
  derived: readonly string[];
  /**
   * Every namespace some loaded bag provides. When undefined the caller could
   * not determine the set (no bags loaded, registry failure), and nothing is
   * pruned — losing a grant is unrecoverable, keeping a stale one is not.
   */
  provided?: ReadonlySet<string>;
}

export function reconcileTraitNamespaces({
  stored,
  derived,
  provided,
}: ReconcileTraitNamespacesInput): TraitNamespaceReconciliation {
  const derivedSet = new Set(derived);
  const kept: string[] = [];
  const pruned: string[] = [];
  const seen = new Set<string>();

  for (const ns of stored) {
    if (derivedSet.has(ns) || seen.has(ns)) continue;
    seen.add(ns);
    // No `provided` set means we cannot tell curated from rotten. Fail safe:
    // keep. An extra namespace grants tools the session may not need; a
    // missing one breaks a session that was working.
    if (!provided || provided.has(ns)) kept.push(ns);
    else pruned.push(ns);
  }

  // Derivation order first so the manifest stays the visible shape of the
  // row, with curated extras appended in their stored order.
  return { namespaces: [...new Set([...derived, ...kept])], kept, pruned };
}
