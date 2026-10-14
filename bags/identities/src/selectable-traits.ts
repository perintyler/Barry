/** The identities bag owns trait selection; service routes and the sessions picker share the same pure query. */
import { identityTraitsFromStore } from "./config/session-bound.js";
import { Identities, resolveIdentityConfig } from "./store/identities.js";
import { Traits } from "./config/traits.js";
import { loadRegistry, expandCompositionFromSnapshot } from "@barry-rocks/sdk/internal/bags";
import { resolveBagAccess } from "@barry-rocks/sdk/bags";

import { createLogger } from "@barry-rocks/sdk/logging";

const log = createLogger("selectable-traits");

/**
 * Read an optional `identityId` query param.
 *
 * An absent param and an empty one mean the same thing — no barry chosen —
 * because that is what a form sends when its picker sits on "inherit". Only a
 * present-but-unparseable value is an error; silently treating it as "no barry"
 * would answer a typo with the full list and look like the scoping had failed.
 */
export function parseIdentityIdParam(
  raw: unknown,
): { ok: true; identityId: number | null } | { ok: false } {
  if (raw === undefined) return { ok: true, identityId: null };
  if (typeof raw !== "string") return { ok: false };
  if (raw.trim() === "") return { ok: true, identityId: null };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return { ok: false };
  return { ok: true, identityId: parsed };
}

/**
 * Traits a reachable, enabled bag still backs — see the GET handler for why
 * the raw table is the wrong thing to serve.
 */
export async function listSelectableTraits(
  identityId?: number | null,
): Promise<Awaited<ReturnType<typeof Traits.list>>> {
  const registry = loadRegistry();
  const registered = Object.entries(registry)
    .filter(([, source]) => resolveBagAccess(source) !== "disabled")
    .map(([name]) => name);

  if (identityId) {
    try {
      const barry = await Identities.get(identityId);
      const explicit = barry ? resolveIdentityConfig(barry).bags : [];
      // Expand composition: `listInstalled` keys traits on their OWNING bag, so
      // a custom trait declared by a sub-bag (distinct from the parent's
      // absorbed auto-trait) would vanish from the picker without this.
      const bags = await expandCompositionFromSnapshot(explicit);
      if (bags.length > 0) {
        // Intersect so a bag the barry lists but which is disabled or absent
        // from the registry still drops out.
        const enabled = new Set(registered);
        const listed = await Traits.listInstalled(bags.filter((b: string) => enabled.has(b)));
        const own = barry ? await identityTraitsFromStore(barry) : [];
        return [...listed, ...own.filter(entry => entry.optional && !listed.some(trait => trait.name === entry.name)).map(entry => ({ ...entry.trait, name: entry.name }))];
      }
    } catch (err) {
      // A barry lookup failure must not blank the picker — fall back to the
      // registry-wide list, which is wider rather than emptier.
      log.warn("sessions.selectable_traits_identity_failed", {
        identityId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return await Traits.listInstalled(registered);
}
