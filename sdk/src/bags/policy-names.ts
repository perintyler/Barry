import type { BagManifest } from "./types.js";

/** Give a bag's declarations an owner: `<bag>:<name>`, except the bag's own trait. */
export function qualifyPolicyNames(manifest: BagManifest): BagManifest {
  if (manifest.name.includes(":")) throw new Error("bag names cannot contain the policy namespace separator");
  // A trait named after its own bag stays bare: the bag's name already IS its
  // namespace, and that trait is the bag's main trait — it must keep
  // overriding the generated one of the same name. Qualifying it to
  // `<bag>:<bag>` silently handed the bare name to the auto-trait, which is
  // always readwrite with no bounds. `first-response-escalate` declares
  // `access: read` (load-bearing, per its manifest) and three bounds; the
  // auto-trait that replaced it granted Slack writes and restricted nothing.
  const qualify = (name: string) => name.includes(":") || name === manifest.name ? name : `${manifest.name}:${name}`;
  const localTraits = new Set(Object.keys(manifest.traits));
  const localBounds = new Set(Object.keys(manifest.bounds ?? {}));
  const traits: BagManifest["traits"] = {};
  for (const name of [...localTraits, ...localBounds]) {
    if (name.includes(":") && !name.startsWith(`${manifest.name}:`)) throw new Error(`${manifest.name} cannot declare another bag's policy ${name}`);
  }
  for (const [name, trait] of Object.entries(manifest.traits)) {
    traits[qualify(name)] = {
      ...trait,
      includes: trait.includes?.map((ref) => localTraits.has(ref) ? qualify(ref) : ref),
      harnessTraits: trait.harnessTraits && Object.fromEntries(Object.entries(trait.harnessTraits).map(([id, ref]) => [id, localTraits.has(ref) ? qualify(ref) : ref])),
      boundNames: trait.boundNames.map((ref) => localBounds.has(ref) ? qualify(ref) : ref),
    };
  }
  const bounds = Object.fromEntries(Object.entries(manifest.bounds ?? {}).map(([name, value]) => [qualify(name), value]));
  const schedules = Object.fromEntries(Object.entries(manifest.schedules).map(([name, schedule]) => [name, { ...schedule,
    traits: schedule.traits?.map((ref) => localTraits.has(ref) ? qualify(ref) : ref),
    bounds: schedule.bounds?.map((ref) => localBounds.has(ref) ? qualify(ref) : ref),
  }]));
  const jobs = manifest.jobs && Object.fromEntries(Object.entries(manifest.jobs).map(([name, job]) => [name, { ...job,
    ...(job.bounds ? { bounds: job.bounds.map((ref) => localBounds.has(ref) ? qualify(ref) : ref) } : {}),
  }]));
  return { ...manifest, schedules, ...(jobs ? { jobs } : {}), traits, ...(manifest.bounds ? { bounds } : {}) };
}
