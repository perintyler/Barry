import { parseTraits, parseBounds, requiredNames } from "@barry-rocks/sdk/internal/identities";
import { CliError, isCliError } from "../lib/cli-error.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { Barry, isBarryError, type Identity, type IdentityUpdate, type Updated } from "@barry-rocks/sdk";
import {
  bounds,
  identityRecords,
  traits,
  type IdentityRecord,
  type TraitInfo,
} from "@barry-rocks/identities-bag";
import { adaptersFromRetired, defaultHarness, FALLBACK_HARNESS, RETIRED_IDENTITY_KEYS, parseVaultName, mergeSecretBindings, type SecretBindings, type IdentityAdapters, type RetiredIdentityKeys } from "@barry-rocks/sdk/internal/identities";
import { getCurrentUser } from "../lib/current-user.js";
import { printWarnings } from "../lib/warnings.js";
import { listBags, upsertBag } from "../bags/registration.js";

/** The configurable root for everything Barry clones, defaulting to ~/repos. */
function reposRoot(): string {
  return process.env.BARRY_REPOS || join(homedir(), "repos");
}

const DEFAULT_CONFIG_DIR_NAME = "my-barry-config";


interface ExportedBarry extends RetiredIdentityKeys {
  name: string;
  bags?: string[];
  /** @deprecated Use bags — kept for backward compat with old exports */
  packs?: string[];
  traits?: string[];
  bounds?: string[];
  bound?: string;
  /** Legacy spelling, still read on import. */
  scope?: string;
  adapters?: IdentityAdapters;
  secrets?: SecretBindings;
  vault?: string;
}

interface ExportedConfig {
  version: 1;
  exported_at: string;
  identities: ExportedBarry[];
}

interface ExportedTrait {
  name: string;
  description: string | null;
  access: string;
  tools: string[];
  /**
   * A trait's grants, under either spelling. Both are live: a shipped trait
   * (the builtin collection's `traits:`) writes `bags:`, while an exported
   * `traits.yaml` writes `namespaces:`. Read them through
   * `readImportedTraitGrants` rather than reaching for either key directly — a
   * file using the other spelling otherwise imports as no grants at all.
   */
  bags?: string[];
  namespaces?: string[];
  skills?: string[];
  /**
   * Instruction names the trait points at. Carried because `upsertTrait`
   * ERASES an omitted column: an import that left this out wiped every
   * imported trait's instructions.
   */
  instructions?: string[];
  bound?: unknown;
  /**
   * Named bounds the trait carries. Carried because a trait exported without
   * them imports onto a fresh machine UNRESTRICTED — the same widening that
   * cost `read` its `readonly` bound.
   */
  boundNames?: string[];
  /** Legacy spelling, still read on import. */
  scope?: unknown;
}

interface ExportedBound {
  name: string;
  description: string | null;
  bound: Record<string, unknown>;
}

/**
 * What Barry ships, or a thrown error — never an empty answer.
 *
 * The shipped list is the only thing separating "the user wrote this" from
 * "Barry ships this". An empty list reclassifies every shipped trait or bound
 * as user-authored: export writes them into the user's config, and a later
 * import upserts them back as if authored there.
 */
function resolveConfigDir(dir?: string): string {
  return dir ?? process.env.BARRY_CONFIG_DIR ?? join(reposRoot(), DEFAULT_CONFIG_DIR_NAME);
}


async function barryToExport(barry: IdentityRecord): Promise<ExportedBarry> {
  identityRecords.config(barry);
  const meta = barry.metadata;
  const exported: ExportedBarry = { name: barry.name };

  if (meta.bags && meta.bags.length > 0) exported.bags = meta.bags;
  if (meta.traits && meta.traits.length > 0) exported.traits = requiredNames(parseTraits(meta.traits));

  exported.bounds = requiredNames(parseBounds(meta.bounds));

  exported.adapters = identityRecords.config(barry).adapters;

  if (meta.secrets && Object.keys(meta.secrets).length) exported.secrets = mergeSecretBindings({}, meta.secrets);

  // Full vault config (connection refs, no actual secrets)
  if (meta.vault) {
    exported.vault = meta.vault;
  }

  return exported;
}

/** Composites Barry shipped before every trait became a bag's. */
const RETIRED_SHIPPED_TRAITS = new Set(["read", "all", "no-native-tools"]);

/** Identify user-defined traits: every trait no bag defines. */
async function exportUserTraits(configDir: string): Promise<number> {
  const dbTraits = await traits.list();

  // Export user traits only: exclude bag definitions and retired shipped composites.
  // See docs/decisions/0041-command-classification-and-completion.md.
  const bagTraitNames = new Set<string>();
  try {
    const { loadAllBags } = await import("@barry-rocks/sdk/internal/bags");
    const { getAllTraits } = await import("@barry-rocks/sdk/internal/bags");
    const bags = await loadAllBags();
    for (const bag of bags) {
      for (const trait of getAllTraits(bag)) {
        bagTraitNames.add(trait.name);
      }
    }
  } catch {
    // @barry-rocks/sdk/bags may not be available
  }

  const userTraits: ExportedTrait[] = [];

  for (const trait of dbTraits) {
    if (RETIRED_SHIPPED_TRAITS.has(trait.name) || bagTraitNames.has(trait.name)) continue;

    userTraits.push(traitToExport(trait));
  }

  if (userTraits.length > 0) {
    writeFileSync(join(configDir, "traits.yaml"), yamlStringify(userTraits), "utf-8");
  } else {
    writeFileSync(join(configDir, "traits.yaml"), "# No user-defined traits\n", "utf-8");
  }

  return userTraits.length;
}

/**
 * A trait's grants from an exported file, under whichever spelling it uses.
 *
 * Two real files disagree: traits a manifest declares write `bags:`,
 * while a `traits.yaml` written by `config export` uses `namespaces:`. Reading
 * only one spelling imports the trait with an EMPTY grant list — a silent
 * narrowing rather than a fail-open, because `filter-tools.ts` does
 * `if (!traitAccess) continue`, so a trait granting nothing yields zero tools.
 * The symptom ("my tools vanished") is loud, but the import reports success, so
 * nothing points back here.
 *
 * `bags` wins when both are present — it is the current spelling, matching how
 * `bound ?? scope` prefers the current key below. An explicit `bags: []` is
 * therefore the answer rather than an absence: falling through to a stale
 * `namespaces:` would resurrect grants the author deliberately removed. A
 * non-array under either key yields `[]` rather than a guess, since guessing
 * wrong is exactly the silent narrowing this exists to prevent.
 */
export function readImportedTraitGrants(trait: {
  bags?: unknown;
  namespaces?: unknown;
}): string[] {
  if (Array.isArray(trait.bags)) return trait.bags as string[];
  if (Array.isArray(trait.namespaces)) return trait.namespaces as string[];
  return [];
}

function traitToExport(trait: TraitInfo): ExportedTrait {
  const exported: ExportedTrait = {
    name: trait.name,
    description: trait.description,
    access: trait.access,
    tools: trait.tools,
    namespaces: trait.namespaces,
  };
  if (trait.skills.length > 0) exported.skills = trait.skills;
  if (trait.instructions.length > 0) exported.instructions = trait.instructions;
  if (Object.keys(trait.bound).length > 0) exported.bound = trait.bound;
  if (trait.boundNames.length > 0) exported.boundNames = trait.boundNames;
  return exported;
}

// A missing shipped-bound catalog must fail rather than reclassify every builtin as user-authored.
// Rationale: docs/decisions/0009-runtime-and-fixture-invariants.md#note-005
async function exportUserBounds(configDir: string): Promise<number> {
  const dbBounds = await bounds.stored();

  const builtinNames = new Set(bounds.shipped().map(bound => bound.name));

  const userBounds: ExportedBound[] = dbBounds
    .filter((s) => !builtinNames.has(s.name) && !s.bag)
    .map((s) => ({
      name: s.name,
      description: s.description,
      bound: s.bound as Record<string, unknown>,
    }));

  if (userBounds.length > 0) {
    writeFileSync(join(configDir, "bounds.yaml"), yamlStringify(userBounds), "utf-8");
  } else {
    writeFileSync(join(configDir, "bounds.yaml"), "# No user-defined bounds\n", "utf-8");
  }

  return userBounds.length;
}

/**
 * Write bags.yaml, a copy for people of the bags this instance registers.
 *
 * Generated from config.db, the one authority for installed bags; nothing
 * reads this file back except `barry config import`. Shipped bags are left
 * out (every checkout re-registers its own), and paths under the home
 * directory are written as `~/…` so the file moves between machines.
 */
async function exportBags(configDir: string): Promise<boolean> {
  const rows = (await listBags()).filter((row) => !row.builtin);
  if (rows.length === 0) return false;
  const home = homedir();
  const registry: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const entry: Record<string, unknown> = { ...row.source };
    if (typeof entry.path === "string" && entry.path.startsWith(home)) {
      entry.path = "~" + entry.path.slice(home.length);
    }
    registry[row.name] = entry;
  }
  writeFileSync(join(configDir, "bags.yaml"), yamlStringify(registry), "utf-8");
  return true;
}

/**
 * Export Barry configuration to the config repo.
 */
export async function configExportCommand(options: { dir?: string; plaintext?: boolean } = {}): Promise<void> {
  try {
    const configDir = resolveConfigDir(options.dir);
    if (!existsSync(configDir)) {
      throw new CliError(`Error: Config directory does not exist: ${configDir}` + "\n" + `\nRun 'barry config init' first to set up the config repo.`, 1);
    }

    const user = await getCurrentUser();
    // Every identity the owner has, as it is in effect (its directory when it
    // has one). The base identity is Barry's, shipped with every checkout, so
    // it is not the user's to export, like the shipped bags and bounds.
    const builtin = identityRecords.builtinDirectory();
    const owned = (await identityRecords.list())
      .filter((entry) => !(builtin && entry.dir === builtin));

    const exportedIdentities = await Promise.all(
      owned.map((entry) => barryToExport(entry.record)),
    );

    const config: ExportedConfig = {
      version: 1,
      exported_at: new Date().toISOString(),
      identities: exportedIdentities,
    };

    writeFileSync(join(configDir, "identities.yaml"), yamlStringify(config), "utf-8");
    console.log(`  identities.yaml — ${exportedIdentities.length} barry${exportedIdentities.length !== 1 ? "s" : ""}`);

    const traitCount = await exportUserTraits(configDir);
    console.log(`  traits.yaml — ${traitCount} user-defined trait${traitCount !== 1 ? "s" : ""}`);

    const boundCount = await exportUserBounds(configDir);
    console.log(`  bounds.yaml — ${boundCount} user-defined bound${boundCount !== 1 ? "s" : ""}`);

    const userSettings = user.settings ?? {};
    const settings: Record<string, unknown> = {};
    if (userSettings.defaultBarry) settings.defaultBarry = userSettings.defaultBarry;
    if (userSettings.defaultSecretStore) settings.defaultSecretStore = userSettings.defaultSecretStore;
    writeFileSync(join(configDir, "settings.yaml"), yamlStringify(settings), "utf-8");
    console.log(`  settings.yaml — exported`);

    if (await exportBags(configDir)) {
      console.log(`  bags.yaml — exported from the bag registry (paths normalized)`);
    }

    // These files carry identity configuration and secret references. Unless
    // --plaintext opts into normal permissions, tighten every exported file to
    // 0600 and say so, so an export never silently lands world-readable.
    if (!options.plaintext) {
      const { chmodSync } = await import("node:fs");
      for (const file of ["identities.yaml", "traits.yaml", "bounds.yaml", "settings.yaml", "bags.yaml"]) {
        const target = join(configDir, file);
        if (existsSync(target)) chmodSync(target, 0o600);
      }
      console.log(`\nExported files written 0600 (owner-only); they hold identity config and secret references. Pass --plaintext for normal permissions.`);
    }

    console.log(`\nExported to ${configDir}`);
    console.log(`Remember to commit and push your changes.`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}


/**
 * Import Barry configuration from the config repo.
 */
export async function configImportCommand(options: { dir?: string } = {}): Promise<void> {
  try {
    const configDir = resolveConfigDir(options.dir);
    if (!existsSync(configDir)) {
      throw new CliError(`Error: Config directory does not exist: ${configDir}`, 1);
    }

    // Refused before anything is written when no owner is bound.
    await getCurrentUser();

    // Import order: traits → bounds → identities → settings
    // (identities may reference bounds by name)

    const traitsPath = join(configDir, "traits.yaml");
    if (existsSync(traitsPath)) {
      const raw = readFileSync(traitsPath, "utf-8");
      const importedTraits = yamlParse(raw) as ExportedTrait[] | null;
      if (Array.isArray(importedTraits) && importedTraits.length > 0) {
        for (const trait of importedTraits) {
          await traits.upsert({
            name: trait.name,
            description: trait.description,
            namespaces: readImportedTraitGrants(trait),
            access: trait.access === "readwrite" ? "readwrite" : "read",
            tools: trait.tools ?? [],
            skills: trait.skills ?? [],
            // Passed only when the file states them. upsertTrait treats an
            // unstated boundNames as "leave the row's alone" and an unstated
            // instructions as "erase"; an older export states neither.
            ...(trait.instructions ? { instructions: trait.instructions } : {}),
            ...(trait.boundNames ? { boundNames: trait.boundNames } : {}),
            bound: trait.bound ?? trait.scope ?? {},
          });
        }
        console.log(`Imported ${importedTraits.length} trait${importedTraits.length !== 1 ? "s" : ""}`);
      }
    }

    // 2. Import bounds.
    //
    // Reads bounds.yaml, falling back to a pre-rename scopes.yaml -- and each
    // entry's body under either `bound:` or the legacy `scope:`. Permanent,
    // not a migration window: this file is in the user's own config repo,
    // which nothing here converts. Reading only the new names would import
    // ZERO bounds from an unconverted config and report success, leaving every
    // restriction the user had written silently absent.
    const boundsPath = [join(configDir, "bounds.yaml"), join(configDir, "scopes.yaml")]
      .find((candidate) => existsSync(candidate));
    if (boundsPath) {
      const raw = readFileSync(boundsPath, "utf-8");
      const importedBounds = yamlParse(raw) as Array<ExportedBound & { scope?: Record<string, unknown> }> | null;
      if (Array.isArray(importedBounds) && importedBounds.length > 0) {
        for (const bound of importedBounds) {
          await bounds.upsert({
            name: bound.name,
            description: bound.description,
            bound: bound.bound ?? bound.scope ?? {},
          });
        }
        console.log(`Imported ${importedBounds.length} bound${importedBounds.length !== 1 ? "s" : ""}`);
      }
    }

    // 3. Restore the bag registry.
    // Must precede barry import: a barry's bag list is resolved against
    // this registry, and on a fresh machine none of those bags are known yet.
    const bagsPath = join(configDir, "bags.yaml");
    if (existsSync(bagsPath)) {
      const entries = (yamlParse(readFileSync(bagsPath, "utf-8")) ?? {}) as Record<string, Record<string, unknown>>;
      for (const [name, source] of Object.entries(entries)) {
        const entry = { ...source };
        if (typeof entry.path === "string" && entry.path.startsWith("~")) entry.path = homedir() + entry.path.slice(1);
        await upsertBag(name, entry);
      }
      console.log(`Registered ${Object.keys(entries).length} bag${Object.keys(entries).length === 1 ? "" : "s"} from bags.yaml`);
    }

    const identitiesPath = join(configDir, "identities.yaml");
    if (existsSync(identitiesPath)) {
      const raw = readFileSync(identitiesPath, "utf-8");
      const config = yamlParse(raw) as Record<string, unknown>;

      if (config.version !== 1) {
        throw new CliError(`Error: Unsupported identities.yaml format version: ${config.version ?? "none"}` + "\n" + `This version of barry supports config format version 1.`, 1);
      }

      if (!config.identities || !Array.isArray(config.identities)) {
        throw new CliError("Error: Invalid identities.yaml — missing 'identities' array", 1);
      }

      for (const identity of config.identities as ExportedBarry[]) {
        if (Object.hasOwn(identity, "env") || Object.hasOwn(identity, "env_file")) throw new Error("Retired identity credential configuration; use secrets references");
        if (identity.secrets) mergeSecretBindings({}, identity.secrets);
        if (identity.vault !== undefined) parseVaultName(identity.vault);
      }

      const builtin = identityRecords.builtinDirectory();
      for (const exported of config.identities as ExportedBarry[]) {
        if (builtin && identityRecords.directory({ name: exported.name }) === builtin) {
          console.warn(`  Skipped "${exported.name}": the base identity Barry ships is not imported`);
          continue;
        }
        const { update, skipped, warned } = await importedUpdate(exported);
        if (skipped.length > 0) {
          console.warn(`  Skipped for "${exported.name}" (no such identity setting): ${skipped.join(", ")}`);
        }

        // An identity is a directory: one that does not exist yet is created
        // in Barry's identities folder, and one that does is updated in place.
        const existing = await identityRecords.find(exported.name).catch(() => undefined);
        let written: Updated<Identity>;
        try {
          written = existing
            ? await Barry.identity(exported.name).update(update)
            : await Barry.createIdentity({ name: exported.name, ...update });
        } catch (error) {
          if (!isBarryError(error)) throw error;
          throw new Error(`"${exported.name}": ${error.message}${error.hint ? `\n  ${error.hint}` : ""}`);
        }
        // The operation syncs the same bags again; their warnings were printed above.
        printWarnings(written.warnings.filter((w) => !warned.has(w.message)));
      }

      const barryCount = (config.identities as ExportedBarry[]).length;
      console.log(`Imported ${barryCount} barry${barryCount !== 1 ? "s" : ""}`);

      // Warn about env vars that need provisioning (vault items / keychain entries)
      const secretIdentities = (config.identities as ExportedBarry[]).filter((p) => p.secrets && Object.keys(p.secrets).length > 0);
      if (secretIdentities.length > 0) {
        console.log(`\nIdentities with secret references (ensure vault items / keychain entries exist):`);
        for (const p of secretIdentities) {
          const keys = Object.keys(p.secrets!).join(", ");
          console.log(`  ${p.name}: ${keys}`);
        }
      }
    }

    const settingsPath = join(configDir, "settings.yaml");
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = yamlParse(raw) as Record<string, unknown> | null;
      if (settings && typeof settings.defaultBarry === "string") {
        // Through the operation, which keeps the rest of the owner's settings
        // as they are now (importing identities above may have claimed the
        // default pointer) and refuses to point at an identity that does not exist.
        await Barry.identity(settings.defaultBarry).makeDefault();
        console.log(`Set active barry to "${settings.defaultBarry}"`);
      }
    }

  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}


/** The settings `ExportedBarry` names, each mapped to its `IdentityUpdate` field below. */
const MAPPED_KEYS = new Set([
  "name", "bags", "packs", "traits", "bound", "scope",
  "adapters", "secrets", "vault",
]);

/** The other `identity.yaml` keys a hand-edited export can carry, and the field each sets. */
const PASSED_KEYS: Readonly<Record<string, keyof IdentityUpdate>> = {
  display_name: "displayName",
  bag_configs: "bagConfigs",
  bounds: "bounds",
  status_notify: "statusNotify",
  aliases: "aliases",
};

/**
 * An exported identity as the update the identities operations take.
 *
 * Best-effort, as a config restore has always been: an unknown bag or trait,
 * or a bound this machine lacks, warns and is left out rather than aborting
 * the whole restore. Any other `identity.yaml` key is passed on (hand-edited
 * files carry them), and reported as skipped when there is no such key,
 * rather than silently dropped.
 */
async function importedUpdate(exported: ExportedBarry): Promise<{ update: IdentityUpdate; skipped: string[]; warned: Set<string> }> {
  const update: IdentityUpdate = {};
  const skipped: string[] = [];
  const warned = new Set<string>();

  const importedBags = exported.bags ?? exported.packs;
  if (importedBags && importedBags.length > 0) {
    const bagResult = await traits.syncBags(importedBags);
    update.bags = bagResult.bags;
    for (const w of bagResult.warnings) {
      console.warn(`  Warning: ${w.message}${w.hint ? ` — ${w.hint}` : ""}`);
      warned.add(w.message);
    }
  }
  if (exported.traits && exported.traits.length > 0) {
    // Read after the bag sync above, which registers the traits its bags declare.
    const knownTraits = new Set((await traits.list()).map((trait) => trait.name));
    const unknown = exported.traits.filter((trait) => !knownTraits.has(trait));
    if (unknown.length > 0) console.warn(`  Warning: trait${unknown.length === 1 ? "" : "s"} ${unknown.map((t) => `"${t}"`).join(", ")} not found for barry "${exported.name}"`);
    // Left unset rather than emptied when none is known: an empty list would
    // clear the traits an existing identity already has.
    const known = exported.traits.filter((trait) => knownTraits.has(trait));
    if (known.length > 0) update.traits = known;
  }
  if (exported.adapters) update.adapters = exported.adapters;
  else if (RETIRED_IDENTITY_KEYS.some(key => Object.hasOwn(exported, key))) {
    const { adapterStore } = await import("../adapters/installed.js");
    const { findInstalled } = await import("@barry-rocks/sdk/adapters/harnesses");
    const { installedModels } = await import("@barry-rocks/sdk/adapters/models");
    await (await import("../lib/models-install.js")).ensureModelsInstalled();
    const records = (await adapterStore()).adapters.installed();
    const vendors = installedModels().vendors();
    const existing = (await identityRecords.list()).find(entry => entry.record.name === exported.name);
    const converted = adaptersFromRetired(Object.fromEntries(RETIRED_IDENTITY_KEYS.filter(key => Object.hasOwn(exported, key)).map(key => [key, exported[key]])), {
      harness: id => findInstalled(records, id)?.id,
      isVendor: id => vendors.some(vendor => vendor.id === id && (vendor.compatible?.length ?? 0) > 0),
      runsOn: defaultHarness(existing?.record.metadata.adapters ?? {}) ?? FALLBACK_HARNESS,
    });
    for (const message of [...converted.notes, ...converted.problems]) console.warn(`  Warning: ${exported.name}: ${message}`);
    if (!converted.problems.length) update.adapters = converted.adapters;
  }

  const exportedBoundName = exported.bound ?? exported.scope;
  if (exported.bounds) update.bounds = exported.bounds;
  else if (typeof exportedBoundName === "string") update.bounds = [exportedBoundName];
  if (exported.secrets) {
    const bindings = mergeSecretBindings({}, exported.secrets);
    update.secrets = Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name, binding.reference]));
  }
  if (exported.vault) update.vault = exported.vault;

  const passed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(exported)) {
    if (MAPPED_KEYS.has(key) || RETIRED_IDENTITY_KEYS.some(retired => retired === key)) continue;
    if (Object.hasOwn(PASSED_KEYS, key)) passed[PASSED_KEYS[key]] = value;
    else if (key === "github") passed.githubInstallationId = typeof value === "object" && value !== null && "installationId" in value ? value.installationId : value;
    else skipped.push(key);
  }
  // Validated by the operation, which refuses a malformed value with its reason.
  return { update: Object.assign(update, passed), skipped, warned };
}

/**
 * Initialize the config backup repo.
 */
export async function configInitCommand(options: { dir?: string } = {}): Promise<void> {
  try {
    const configDir = resolveConfigDir(options.dir);

    if (existsSync(join(configDir, ".git"))) {
      console.log(`Config repo already exists at ${configDir}`);
      console.log(`Running export instead...\n`);
      await configExportCommand(options);
      return;
    }

    mkdirSync(configDir, { recursive: true });

    execSync("git init", { cwd: configDir, stdio: "pipe" });

    writeFileSync(
      join(configDir, ".gitignore"),
      ["*.db", "*.db-shm", "*.db-wal", ".DS_Store", ""].join("\n"),
      "utf-8",
    );

    await configExportCommand(options);

    execSync("git add -A", { cwd: configDir, stdio: "pipe" });
    execSync('git commit -m "Initial barry config export"', { cwd: configDir, stdio: "pipe" });

    console.log(`\nInitialized config repo at ${configDir}`);
    console.log(`\nTo back up to a remote:`);
    console.log(`  cd ${configDir}`);
    console.log(`  git remote add origin <your-repo-url>`);
    console.log(`  git push -u origin main`);
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}
