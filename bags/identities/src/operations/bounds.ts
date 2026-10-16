/**
 * Named bounds, for the processes hosting this bag, which act with the
 * installation's authority. A caller asking on someone's behalf reads them
 * through `Barry.bounds()`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import type { Bound } from "@barry-rocks/sdk";
import { barryConfigDir } from "@barry-rocks/sdk/services";
import { loadBagSync, loadRegistry } from "@barry-rocks/sdk/internal/bags";
import { parseBounds } from "@barry-rocks/sdk/internal/identities";
import type { IdentityRecord } from "../store/identities.js";
import { baseIdentityConfig } from "../store/identity-files.js";

function safeSnapshotBags() {
  try {
    const registry = loadRegistry();
    return Object.keys(registry).flatMap((name) => {
      const bag = loadBagSync(name);
      return bag ? [bag] : [];
    });
  } catch {
    return [];
  }
}

function userConfigBounds(): Bound[] {
  try {
    const file = join(barryConfigDir(), "identity.yaml");
    if (!existsSync(file)) return [];
    const raw = yamlParse(readFileSync(file, "utf8")) as { bounds?: unknown } | null;
    if (Array.isArray(raw?.bounds)) {
      return parseBounds(raw.bounds).flatMap((entry) =>
        entry.bound ? [{ ...entry.bound, name: entry.name }] : [],
      );
    }
    if (raw?.bounds && typeof raw.bounds === "object") {
      return Object.entries(raw.bounds as Record<string, unknown>).flatMap(([name, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const { optional: _optional, ...rest } = value as Record<string, unknown>;
        return [{ ...(rest as Bound), name }];
      });
    }
    return [];
  } catch {
    return [];
  }
}

export const bounds = {
  shipped(): Bound[] {
    return (baseIdentityConfig()?.bounds ?? []).flatMap((entry) =>
      entry.bound ? [{ ...entry.bound, name: entry.name }] : [],
    );
  },
  /** Base identity.yaml ∪ the identity's identity.yaml ∪ installed local bags' bag.yaml. */
  async list(identity?: IdentityRecord): Promise<Bound[]> {
    const result: Bound[] = [];
    const seen = new Set<string>();
    for (const bound of userConfigBounds()) {
      if (bound.name && !seen.has(bound.name)) {
        seen.add(bound.name);
        result.push(bound);
      }
    }
    for (const bound of bounds.shipped()) {
      if (bound.name && !seen.has(bound.name)) {
        seen.add(bound.name);
        result.push(bound);
      }
    }
    if (identity) {
      for (const entry of parseBounds(identity.metadata.bounds)) {
        if (entry.bound && !seen.has(entry.name)) {
          seen.add(entry.name);
          result.push({ ...entry.bound, name: entry.name });
        }
      }
    }
    for (const bag of safeSnapshotBags()) {
      for (const [name, definition] of Object.entries(bag.manifest?.bounds ?? {})) {
        if (!seen.has(name)) {
          seen.add(name);
          result.push({
            ...definition.bound,
            name,
            ...(definition.description ? { description: definition.description } : {}),
          });
        }
      }
    }
    return result;
  },
  async get(nameOrRef: string | { name: string }, identity?: IdentityRecord): Promise<Bound | undefined> {
    const name = typeof nameOrRef === "string" ? nameOrRef : nameOrRef.name;
    const userMatch = userConfigBounds().find((bound) => bound.name === name);
    if (userMatch) return userMatch;
    const shippedMatch = bounds.shipped().find((bound) => bound.name === name);
    if (shippedMatch) return shippedMatch;
    if (identity) {
      const identityMatch = parseBounds(identity.metadata.bounds).find(
        (entry) => entry.name === name && entry.bound,
      );
      if (identityMatch?.bound) return { ...identityMatch.bound, name: identityMatch.name };
    }
    const all = await bounds.list(identity);
    const exact = all.find((bound) => bound.name === name);
    if (exact) return exact;
    const bags = safeSnapshotBags();
    if (name.includes(":")) {
      const [bagName, ...rest] = name.split(":");
      const shortName = rest.join(":");
      const bag = bags.find((b) => b.name === bagName);
      const definition = bag?.manifest?.bounds?.[shortName] ?? bag?.manifest?.bounds?.[name];
      if (definition) {
        return {
          ...definition.bound,
          name,
          ...(definition.description ? { description: definition.description } : {}),
        };
      }
    } else {
      for (const bag of bags) {
        const qualified = `${bag.name}:${name}`;
        const definition = bag.manifest?.bounds?.[qualified];
        if (definition) {
          return {
            ...definition.bound,
            name: qualified,
            ...(definition.description ? { description: definition.description } : {}),
          };
        }
      }
    }
    if (name.endsWith(":read") && name.length > ":read".length) {
      const bagName = name.slice(0, -":read".length);
      if (bags.some((b) => b.name === bagName)) {
        return { name, tools: { deny: [`${bagName}:write`] } };
      }
    }
    return undefined;
  },
};
