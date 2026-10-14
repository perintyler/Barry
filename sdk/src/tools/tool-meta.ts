/**
 * Collect tool metadata from all bags for trait-based access control.
 *
 * Every bag's `tools` in the registry snapshot: for a local bag, the summary
 * its loader read beside the built bundle (contract hash included), so no bag
 * code is imported here; for a remote bag, the registry's inline list.
 */

import { clearBagRegistrySnapshot, loadBagRegistrySnapshot } from "../bags/loader.js";
import type { BagRegistrySnapshot } from "../bags/types.js";

/** Tool metadata for trait-based access control — matches @barry-rocks/sdk/bounds ToolMeta */
export interface ToolMetaEntry {
  toolName: string;
  namespace: string;
  access: "read" | "write";
  /** Retain the contributing bag for access-control provenance, permitting absence only for legacy cache entries or hand-built fixtures; see docs/decisions/0014-discovery-vault-and-session-budgets.md. */
  bag?: string;
  /** Stable fingerprint of the declared input/output contract and access level. */
  contractHash?: string;
  /** What the tool does, when its definition says. */
  description?: string;
}

/** Cached result — metadata is static for the process lifetime */
let cached: ToolMetaEntry[] | null = null;

/**
 * Collapse a tool's declared access to the two levels `filterTools` understands.
 *
 * `ToolMeta.access` is `"read" | "write"`, but the three places a level is
 * authored do not agree on that vocabulary: `ToolMetaSchema` accepts
 * `read | readwrite | write`, and a tool module is free to export any string.
 * `filterTools` then withholds a tool from a read-only trait on exactly one
 * test — `tool.access === "write"` — so ANY other spelling is treated as
 * readable.
 *
 * That makes the mapping fail-open, which is the wrong direction: a tool
 * stamped `"readwrite"` (the spelling the manifest schema explicitly allows,
 * and the one every trait and bag uses) would be handed to a `access: read`
 * trait. Only the literal `"read"` is read; everything else, including an
 * unrecognized value, is write.
 */
export function normalizeAccess(access: string): "read" | "write" {
  return access === "read" ? "read" : "write";
}

/**
 * Collect tool metadata from all registered bags.
 *
 * Result is cached for the process lifetime. Call `clearToolMetaCache()`
 * to force a reload (e.g. after hot-reloading bags).
 */
export async function collectToolMeta(snapshot?: BagRegistrySnapshot): Promise<ToolMetaEntry[]> {
  if (cached && !snapshot) return cached;

  const resolved = snapshot ?? await loadBagRegistrySnapshot();
  const seen = new Map<string, ToolMetaEntry>();

  for (const bag of resolved.bags) {
    for (const tool of bag.tools ?? []) {
      const id = `${tool.namespace}:${tool.toolName}`;
      if (!seen.has(id)) {
        seen.set(id, {
          toolName: tool.toolName,
          namespace: tool.namespace,
          access: normalizeAccess(tool.access),
          bag: bag.name,
          ...(tool.contractHash ? { contractHash: tool.contractHash } : {}),
          ...(tool.description ? { description: tool.description } : {}),
        });
      }
    }
  }

  const result = Array.from(seen.values());
  if (!snapshot) cached = result;
  return result;
}

/** Clear the cached tool metadata (for hot-reload scenarios) */
export function clearToolMetaCache(): void {
  cached = null;
  clearBagRegistrySnapshot();
}
