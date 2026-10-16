import type { BagManifest } from "./types.js";

/** Give a bag's bound declarations an owner: `<bag>:<name>`. */
export function qualifyBoundNames(manifest: BagManifest): BagManifest {
  if (manifest.name.includes(":")) throw new Error("bag names cannot contain the bound namespace separator");
  const qualify = (name: string) => name.includes(":") || name === manifest.name ? name : `${manifest.name}:${name}`;
  const localBounds = new Set(Object.keys(manifest.bounds ?? {}));
  for (const name of localBounds) {
    if (name.includes(":") && !name.startsWith(`${manifest.name}:`)) throw new Error(`${manifest.name} cannot declare another bag's bound ${name}`);
  }
  const bounds = Object.fromEntries(Object.entries(manifest.bounds ?? {}).map(([name, value]) => [qualify(name), value]));
  const schedules = Object.fromEntries(Object.entries(manifest.schedules).map(([name, schedule]) => [name, { ...schedule,
    ...(schedule.bags ? { bags: schedule.bags } : {}),
    bounds: schedule.bounds?.map((ref) => localBounds.has(ref) ? qualify(ref) : ref),
  }]));
  const jobs = manifest.jobs && Object.fromEntries(Object.entries(manifest.jobs).map(([name, job]) => [name, { ...job,
    ...(job.bounds ? { bounds: job.bounds.map((ref) => localBounds.has(ref) ? qualify(ref) : ref) } : {}),
  }]));
  return { ...manifest, schedules, ...(jobs ? { jobs } : {}), ...(manifest.bounds ? { bounds } : {}) };
}

