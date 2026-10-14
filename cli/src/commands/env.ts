/** Audit private installation keys and the selected credential bindings without printing values. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { barryEnvPath, readInstanceEnv, ENV_RULES } from "@barry-rocks/sdk/services";


import type { Bag } from "@barry-rocks/sdk/bags";
import { findActionFile, parseActionFile } from "@barry-rocks/sdk/internal/actions";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";

/** What of a bag says which env keys it reads. */
export type EnvDeclaringBag = Pick<Bag, "name" | "schedules" | "actionsDirs" | "jobs"> & {
  services: Array<{ name: string; secrets?: string[] }>;
  manifest?: { scripts?: Record<string, { env?: string[]; secrets?: string[] }> } | null;
};

/** One declaration of an instance env key. */
export interface EnvDeclaration {
  key: string;
  /** Who declares it: `core`, `<bag>.<service>`, `<bag> schedule <name>`, `<bag> action <name>`. */
  by: string;
  required: boolean;
  binding?: boolean;
}

/** Credential requirements may belong to an identity rather than the instance file.
 * The `run:` actions a bag ships, with their declared names. Unreadable actions are another check's problem. */
function bagActionEnv(bag: EnvDeclaringBag): EnvDeclaration[] {
  const out: EnvDeclaration[] = [];
  for (const dir of bag.actionsDirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const actionDir = join(dir, name);
      if (!findActionFile(actionDir)) continue;
      try {
        const action = parseActionFile(actionDir);
        if (action.run) out.push(...(action.secrets ?? []).map(key => ({ key, by: `${bag.name} action ${action.name}`, required: false })));
      } catch {
        // An invalid action is reported by `barry bag check`, not here.
      }
    }
  }
  return out;
}

/** Every declaration core and the given bags make. */
export function envDeclarations(bags: EnvDeclaringBag[]): EnvDeclaration[] {
  const declarations: EnvDeclaration[] = ENV_RULES.map((rule) => ({
    key: rule.name,
    by: "core",
    required: rule.required === "always",
    binding: rule.name === "BARRY_SECRET",
  }));
  for (const bag of bags) {
    for (const service of bag.services) {
      declarations.push(...(service.secrets ?? []).map(key => ({ key, by: `${bag.name}.${service.name}`, required: true, binding: true })));
    }
    for (const schedule of bag.schedules) {
      if (schedule.payload.kind !== "inline") continue;
      const action = schedule.payload.manifest;
      if (action.run) declarations.push(...(action.secrets ?? []).map(key => ({ key, by: `${bag.name} schedule ${schedule.name}`, required: false })));
    }
    for (const job of bag.jobs ?? []) {
      if (job.runs.using === "action") continue;
      declarations.push(...(job.runs.secrets ?? []).map(key => ({ key, by: `${bag.name} job ${job.name}`, required: false })));
    }
    declarations.push(...bagActionEnv(bag));
    for (const [name, script] of Object.entries(bag.manifest?.scripts ?? {})) {
      declarations.push(...(script.secrets ?? []).map(key => ({ key, by: `${bag.name} script ${name}`, required: true, binding: true })));
    }
  }
  return declarations;
}

export interface EnvAudit {
  /** Required installation configuration or selected credential binding is unavailable. */
  missing: Array<{ key: string; by: string[] }>;
  /** In the instance env, declared by nobody. */
  undeclared: string[];
  /** In the instance env and declared, with who declares each. */
  declared: Array<{ key: string; by: string[] }>;
}

export function auditEnv(present: string[], declarations: EnvDeclaration[], availableBindings: readonly string[] = []): EnvAudit {
  const byKey = new Map<string, EnvDeclaration[]>();
  for (const d of declarations) byKey.set(d.key, [...(byKey.get(d.key) ?? []), d]);
  const have = new Set(present);
  const missing = [...byKey]
    .filter(([key, ds]) => ds.some(d => d.required && !(d.binding ? availableBindings.includes(key) : have.has(key))))
    .map(([key, ds]) => ({ key, by: [...new Set(ds.filter(d => d.required && !(d.binding ? availableBindings.includes(key) : have.has(key))).map(d => d.by))] }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const undeclared = present.filter((key) => !byKey.has(key)).sort();
  const declared = present
    .filter((key) => byKey.has(key))
    .sort()
    .map((key) => ({ key, by: [...new Set((byKey.get(key) ?? []).map((d) => d.by))] }));
  return { missing, undeclared, declared };
}

/**
 * Print the audit. Non-zero when a required key is missing or a key nothing
 * declares is present, so it can gate a cleanup. Refuses to judge when no bag
 * loads: every bag's key would then read as undeclared, and that output looks
 * like a list of keys safe to delete.
 */
export async function envAuditCommand(): Promise<void> {
  const { loadAllBags } = await import("@barry-rocks/sdk/internal/bags");
  const bags = await loadAllBags();
  if (bags.length === 0) {
    console.error("No installed bag loaded, so which keys are declared cannot be judged. Is the bag snapshot readable?");
    process.exitCode = 1;
    return;
  }
  const present = Object.keys(readInstanceEnv());
  const declarations = envDeclarations(bags);
  const availableBindings: string[] = [];
  for (const name of new Set(declarations.filter(d => d.required && d.binding).map(d => d.key))) {
    try {
      const values = await installationSecrets([name]);
      if (values[name]) availableBindings.push(name);
    } catch {
      // Report only the declared name, never backend details or credential values.
    }
  }
  const { missing, undeclared, declared } = auditEnv(present, declarations, availableBindings);
  const width = Math.max(0, ...[...present, ...missing.map((m) => m.key)].map((k) => k.length));

  console.log(`${barryEnvPath()} (${present.length} keys; declarations from core and ${bags.length} bags)`);
  for (const { key, by } of declared) console.log(`  ${key.padEnd(width)}  ${by.join(", ")}`);
  for (const key of undeclared) console.log(`  ${key.padEnd(width)}  UNDECLARED`);
  for (const { key, by } of missing) console.log(`  ${key.padEnd(width)}  MISSING (required by ${by.join(", ")})`);

  if (missing.length > 0) {
    console.log(`\n${missing.length} required key(s) unavailable. Check the installation secret bindings and private environment file.`);
    process.exitCode = 1;
  }
  if (undeclared.length > 0) {
    console.log(
      `\n${undeclared.length} key(s) nothing declares, so no service receives them. Nothing was changed. ` +
        "Review external consumers before removing private-file entries.",
    );
    process.exitCode = 1;
  }
}
