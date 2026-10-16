import {
  parseBounds,
  requiredNames,
  serializeEntries,
  parseIdentityBags,
  serializeIdentityBags,
  type IdentityBags,
  type IdentityEntries,
  adaptersFromRetired,
  defaultHarness,
  FALLBACK_HARNESS,
  RETIRED_IDENTITY_KEYS,
  parseVaultName,
  mergeSecretBindings,
  type SecretBindings,
  type IdentityAdapters,
  type RetiredIdentityKeys,
} from "@barry-rocks/sdk/internal/identities";
import { CliError, isCliError } from "../lib/cli-error.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { Barry, isBarryError, type Identity, type IdentityUpdate, type Updated } from "@barry-rocks/sdk";
import {
  bounds,
  identityRecords,
  resolveBags,
  type IdentityRecord,
} from "@barry-rocks/identities-bag";
import { getCurrentUser } from "../lib/current-user.js";
import { printWarnings } from "../lib/warnings.js";
import { listBags, upsertBag } from "../bags/registration.js";
import {
  hasLegacyBoundKeys,
  migrateIdentityYamlObject,
  SHIPPED_GLOBAL_BOUND_NAMES,
  type TraitRowSummary,
} from "./doctor-migration.js";

/** The configurable root for everything Barry clones, defaulting to ~/repos. */
function reposRoot(): string {
  return process.env.BARRY_REPOS || join(homedir(), "repos");
}

const DEFAULT_CONFIG_DIR_NAME = "my-barry-config";

interface ExportedBarry extends RetiredIdentityKeys {
  name: string;
  bags?: IdentityBags;
  /** @deprecated Use bags — kept for backward compat with old exports */
  packs?: string[];
  traits?: unknown[];
  bounds?: IdentityEntries;
  bound?: string | Record<string, unknown>;
  /** Legacy spelling, still read on import. */
  scope?: string | Record<string, unknown>;
  adapters?: IdentityAdapters;
  secrets?: SecretBindings;
  vault?: string;
}

interface ExportedConfig {
  version: 1;
  exported_at: string;
  identities: ExportedBarry[];
}

interface LegacyExportedTrait {
  name: string;
  description?: string | null;
  access?: string;
  tools?: string[];
  bags?: string[];
  namespaces?: string[];
  skills?: string[];
  instructions?: string[];
  bound?: Record<string, unknown>;
  boundNames?: string[];
  scope?: Record<string, unknown>;
}

interface LegacyExportedBound {
  name: string;
  description?: string | null;
  bound?: Record<string, unknown>;
  scope?: Record<string, unknown>;
}

function resolveConfigDir(dir?: string): string {
  return dir ?? process.env.BARRY_CONFIG_DIR ?? join(reposRoot(), DEFAULT_CONFIG_DIR_NAME);
}

async function barryToExport(barry: IdentityRecord): Promise<ExportedBarry> {
  const resolved = identityRecords.config(barry);
  const meta = barry.metadata;
  const exported: ExportedBarry = { name: barry.name };

  if (meta.bags && meta.bags.length > 0) {
    exported.bags = serializeIdentityBags(meta.bags, meta.bag_configs ?? {});
  }

  exported.bounds = serializeEntries(parseBounds(meta.bounds));

  exported.adapters = resolved.adapters;

  if (meta.secrets && Object.keys(meta.secrets).length) {
    exported.secrets = mergeSecretBindings({}, meta.secrets);
  }

  // Full vault config (connection refs, no actual secrets)
  if (meta.vault) {
    exported.vault = meta.vault;
  }

  return exported;
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
      for (const file of ["identities.yaml", "settings.yaml", "bags.yaml"]) {
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

function readLegacyTraitsMap(configDir: string): Map<string, TraitRowSummary> {
  const map = new Map<string, TraitRowSummary>();
  const traitsPath = join(configDir, "traits.yaml");
  if (!existsSync(traitsPath)) return map;
  const importedTraits = yamlParse(readFileSync(traitsPath, "utf-8")) as LegacyExportedTrait[] | null;
  if (!Array.isArray(importedTraits)) return map;
  for (const trait of importedTraits) {
    if (!trait || typeof trait.name !== "string") continue;
    const namespaces = Array.isArray(trait.bags)
      ? trait.bags
      : Array.isArray(trait.namespaces)
        ? trait.namespaces
        : [];
    const boundObject = trait.bound ?? trait.scope;
    map.set(trait.name, {
      name: trait.name,
      access: trait.access === "read" ? "read" : "readwrite",
      namespaces,
      boundNames: Array.isArray(trait.boundNames) ? trait.boundNames : [],
      bound: boundObject && typeof boundObject === "object" && Object.keys(boundObject).length > 0 ? boundObject : null,
    });
  }
  return map;
}

function readLegacyCustomBounds(configDir: string): Array<{ name: string; description?: string | null; bound: Record<string, unknown> }> {
  const boundsPath = [join(configDir, "bounds.yaml"), join(configDir, "scopes.yaml")]
    .find((candidate) => existsSync(candidate));
  if (!boundsPath) return [];
  const importedBounds = yamlParse(readFileSync(boundsPath, "utf-8")) as LegacyExportedBound[] | null;
  if (!Array.isArray(importedBounds)) return [];
  const shipped = new Set<string>(SHIPPED_GLOBAL_BOUND_NAMES);
  const out: Array<{ name: string; description?: string | null; bound: Record<string, unknown> }> = [];
  for (const bound of importedBounds) {
    if (!bound || typeof bound.name !== "string" || shipped.has(bound.name)) continue;
    const rawBound = bound.bound ?? bound.scope ?? {};
    out.push({
      name: bound.name,
      description: bound.description ?? null,
      bound: rawBound && typeof rawBound === "object" ? rawBound : {},
    });
  }
  return out;
}

const LEGACY_GRANT_KEY = ["bag", "grant"].join("_");

function needsLegacyIdentityMigration(
  exported: ExportedBarry,
  customBoundsCount: number,
): boolean {
  if (customBoundsCount > 0) return true;
  if (Object.hasOwn(exported, "traits") || Object.hasOwn(exported, LEGACY_GRANT_KEY)) return true;
  const boundObject = exported.bound ?? exported.scope;
  if (boundObject && typeof boundObject === "object") return true;
  if (Array.isArray(exported.bounds)) {
    for (const entry of exported.bounds) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        if (hasLegacyBoundKeys(entry)) return true;
        for (const val of Object.values(entry)) {
          if (hasLegacyBoundKeys(val)) return true;
        }
      }
    }
  }
  return false;
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
    const user = await getCurrentUser();

    // 1. Restore the bag registry first: an identity's bag list is resolved against
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

    const legacyTraitsMap = readLegacyTraitsMap(configDir);
    const legacyCustomBounds = readLegacyCustomBounds(configDir);

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
      const settingsPath = join(configDir, "settings.yaml");
      const importedSettings = existsSync(settingsPath)
        ? (yamlParse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown> | null)
        : null;
      const defaultIdentityName =
        typeof importedSettings?.defaultBarry === "string"
          ? importedSettings.defaultBarry
          : typeof user.settings?.defaultBarry === "string"
            ? user.settings.defaultBarry
            : (config.identities as ExportedBarry[])[0]?.name;

      for (const rawExported of config.identities as ExportedBarry[]) {
        if (builtin && identityRecords.directory({ name: rawExported.name }) === builtin) {
          console.warn(`  Skipped "${rawExported.name}": the base identity Barry ships is not imported`);
          continue;
        }
        const customForThisIdentity =
          rawExported.name === defaultIdentityName ? legacyCustomBounds : [];
        let exported = rawExported;
        if (needsLegacyIdentityMigration(rawExported, customForThisIdentity.length)) {
          const doc: Record<string, unknown> = { ...(rawExported as unknown as Record<string, unknown>) };
          if (typeof doc.bound === "string" || typeof doc.scope === "string") {
            const boundName = (doc.bound ?? doc.scope) as string;
            doc.bounds = Array.isArray(doc.bounds) ? [...doc.bounds, boundName] : [boundName];
            delete doc.bound;
            delete doc.scope;
          }
          const migrated = migrateIdentityYamlObject(doc, {
            identityName: rawExported.name,
            traitsTableMap: legacyTraitsMap,
            customBoundsToAdd: customForThisIdentity,
          });
          exported = migrated.updated as unknown as ExportedBarry;
        }

        const { update, fullBounds, skipped, warned } = await importedUpdate(exported);
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
        if (fullBounds && written.directory) {
          const yamlPath = join(written.directory, "identity.yaml");
          const currentYaml = (yamlParse(readFileSync(yamlPath, "utf-8")) ?? {}) as Record<string, unknown>;
          currentYaml.bounds = fullBounds;
          const tmpPath = `${yamlPath}.tmp`;
          writeFileSync(tmpPath, yamlStringify(currentYaml), "utf-8");
          renameSync(tmpPath, yamlPath);
          await identityRecords.sync(written.directory, { actorId: user.id });
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
  "name", "bags", "packs", "traits", "bounds", "bound", "scope",
  "adapters", "secrets", "vault",
]);

/** The other `identity.yaml` keys a hand-edited export can carry, and the field each sets. */
const PASSED_KEYS: Readonly<Record<string, keyof IdentityUpdate>> = {
  display_name: "displayName",
  bag_configs: "bagConfigs",
  status_notify: "statusNotify",
  aliases: "aliases",
};

/**
 * An exported identity as the update the identities operations take.
 *
 * Best-effort, as a config restore has always been: an unknown bag or a bound
 * this machine lacks warns and is left out rather than aborting the whole
 * restore. Any other `identity.yaml` key is passed on (hand-edited files carry
 * them), and reported as skipped when there is no such key, rather than
 * silently dropped.
 */
async function importedUpdate(exported: ExportedBarry): Promise<{
  update: IdentityUpdate;
  fullBounds: IdentityEntries | undefined;
  skipped: string[];
  warned: Set<string>;
}> {
  const update: IdentityUpdate = {};
  let fullBounds: IdentityEntries | undefined;
  const skipped: string[] = [];
  const warned = new Set<string>();

  const rawBags = exported.bags ?? exported.packs;
  if (rawBags !== undefined) {
    const parsed = parseIdentityBags(rawBags);
    if (parsed.bags.length > 0) {
      const bagResult = await resolveBags(parsed.bags);
      update.bags = bagResult.bags;
      const kept = new Set(bagResult.bags);
      const bagConfigs = Object.fromEntries(
        Object.entries(parsed.bag_configs).filter(([name]) => kept.has(name)),
      );
      if (Object.keys(bagConfigs).length > 0) {
        update.bagConfigs = bagConfigs;
      }
      for (const w of bagResult.warnings) {
        console.warn(`  Warning: ${w.message}${w.hint ? ` — ${w.hint}` : ""}`);
        warned.add(w.message);
      }
    }
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
  if (exported.bounds) {
    const parsedBounds = parseBounds(exported.bounds);
    const availableBounds = new Set((await bounds.list()).map((entry) => entry.name));
    const validEntries = parsedBounds.filter((entry) => {
      if (entry.bound) return true;
      if (availableBounds.has(entry.name)) return true;
      console.warn(`  Warning: bound "${entry.name}" not found for barry "${exported.name}"`);
      return false;
    });
    const hasInlineOrOptional = validEntries.some((entry) => Boolean(entry.bound) || entry.optional);
    if (hasInlineOrOptional) {
      fullBounds = serializeEntries(validEntries);
    } else {
      update.bounds = requiredNames(validEntries);
    }
  } else if (typeof exportedBoundName === "string") {
    update.bounds = [exportedBoundName];
  }

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
  return { update: Object.assign(update, passed), fullBounds, skipped, warned };
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
