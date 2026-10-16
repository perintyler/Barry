import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { BoundSchema, type Bound } from "@barry-rocks/sdk/bounds";
import { parseBounds } from "@barry-rocks/sdk/internal/identities";
import { loadAllBags } from "@barry-rocks/sdk/internal/bags";
import { installationRoot } from "@barry-rocks/sdk/services";
import { identityRecords } from "@barry-rocks/identities-bag";
import { summarizeBound } from "../lib/bound-summary.js";

export interface BoundListEntry {
  name: string;
  source: "global" | "identity" | "bag";
  owner?: string;
  description?: string;
  bound: Bound;
  summary: string;
}

/**
 * Collect all named bounds across the three declaration sources:
 * 1. Global bounds in root `identity.yaml`
 * 2. Identity bounds in each identity's `identity.yaml`
 * 3. Bag bounds in installed bags' `manifest.bounds` (qualified as `<bag>:<bound>`)
 */
export async function listNamedBounds(): Promise<BoundListEntry[]> {
  const entries: BoundListEntry[] = [];
  const seen = new Set<string>();

  try {
    const rootYamlPath = join(installationRoot(), "identity.yaml");
    if (existsSync(rootYamlPath)) {
      const raw = parse(readFileSync(rootYamlPath, "utf8")) as { bounds?: unknown } | null;
      for (const parsed of parseBounds(raw?.bounds ?? [])) {
        if (!parsed.bound || seen.has(parsed.name)) continue;
        seen.add(parsed.name);
        const bound = BoundSchema.parse(parsed.bound);
        entries.push({
          name: parsed.name,
          source: "global",
          description: bound.description,
          bound,
          summary: summarizeBound(bound),
        });
      }
    }
  } catch {
    // Root identity.yaml unavailable; proceed with identity and bag bounds.
  }

  try {
    const listedIdentities = await identityRecords.list();
    for (const item of listedIdentities) {
      if (item.record.name === "base") continue;
      const identityBounds = parseBounds(item.record.metadata.bounds ?? []);
      for (const parsed of identityBounds) {
        if (!parsed.bound || seen.has(parsed.name)) continue;
        const key = `${item.record.name}:${parsed.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bound = BoundSchema.parse(parsed.bound);
        entries.push({
          name: parsed.name,
          source: "identity",
          owner: item.record.name,
          description: bound.description,
          bound,
          summary: summarizeBound(bound),
        });
      }
    }
  } catch {
    // Identity store not initialized; skip identity bounds.
  }

  try {
    const bags = await loadAllBags();
    for (const bag of bags) {
      for (const [rawKey, def] of Object.entries(bag.manifest?.bounds ?? {})) {
        const qualified = rawKey.includes(":") ? rawKey : `${bag.name}:${rawKey}`;
        if (seen.has(qualified)) continue;
        seen.add(qualified);
        const rawBound =
          def && typeof def === "object" && "bound" in def && def.bound
            ? def.bound
            : def;
        const bound = BoundSchema.parse(rawBound);
        const description =
          (def && typeof def === "object" && "description" in def && typeof def.description === "string"
            ? def.description
            : undefined) ?? bound.description;
        entries.push({
          name: qualified,
          source: "bag",
          owner: bag.name,
          description,
          bound,
          summary: summarizeBound(bound),
        });
      }
    }
  } catch {
    // Bag registry unavailable; skip bag bounds.
  }

  return entries;
}

export async function boundListCommand(options?: { json?: boolean }): Promise<void> {
  const allBounds = await listNamedBounds();

  if (options?.json) {
    console.log(JSON.stringify(allBounds, null, 2));
    return;
  }

  if (allBounds.length === 0) {
    console.log("No bounds found.");
    return;
  }

  console.log("Bounds:\n");
  for (const entry of allBounds) {
    const label = entry.owner ? `${entry.name} (${entry.source}: ${entry.owner})` : `${entry.name} (${entry.source})`;
    console.log(`  ${label}`);
    if (entry.description) {
      console.log(`    ${entry.description}`);
    }
    console.log(`    ${entry.summary}`);
    console.log("");
  }
}

