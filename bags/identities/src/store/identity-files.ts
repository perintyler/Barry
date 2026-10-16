/**
 * File-based Barry reader and writer.
 *
 * Reads an identity directory's `identity.yaml` and converts
 * them into a `IdentityRecord` that the existing `resolveIdentityConfig` can
 * consume unchanged. The directory is the source of truth; the DB is a cache
 * that `syncIdentityToDb` keeps up to date.
 *
 * Lives in the identities bag so it can feed directly into the resolver and the sync
 * path can use Identities without a dependency cycle.
 */

import { createHash } from "node:crypto";
import {
  statSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname, resolve } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  getIdentitiesDir,
  getIdentityDir,
  getIdentitiesRegistryPath,
  getLegacyIdentitiesDir,
  getLegacyIdentitiesRegistryPath,
  getBuiltinIdentityDir,
} from "../paths.js";
import { parseBounds, inheritEntries, serializeEntries, ownEntries, type IdentityEntries, resolveIdentityConfig, IdentityAdaptersSchema, mergeAdapters, ownAdapters, RETIRED_IDENTITY_KEYS, type IdentityAdapters, parseVaultName, bindSecretReferences, mergeSecretBindings, mergeInheritedIdentity, parseIdentityBags, serializeIdentityBags, type IdentityBags } from "@barry-rocks/sdk/internal/identities";

import { findInstalled } from "@barry-rocks/sdk/adapters/harnesses";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { invalidateIdentityEnvironment } from "@barry-rocks/sdk/internal/env";
import { bagLoadInputs } from "@barry-rocks/sdk/internal/bags";
import { barryCacheDir, barryAdaptersPath } from "@barry-rocks/sdk/services";

import type { IdentityRecord, IdentityMetadata } from "./identities.js";
import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("identities.files", { transport: "stderr" });

/**
 * The actor named when reading the SHIPPED base identity template for its
 * metadata alone. The base read produces a `ResolvedIdentityConfig`, never an
 * owned `IdentityRecord` that leaves this module, so this value never reaches
 * an ownership check. It exists only because POL-19 made the reader require an
 * explicit actor instead of silently defaulting to actor 1.
 */
const BASE_TEMPLATE_ACTOR = 1;



const warnedFiles = new Set<string>();
export function warnIdentityFile(path: string, message: string): void {
  const key = `${path}\n${message}`;
  if (warnedFiles.has(key)) return;
  warnedFiles.add(key);
  diagnostics.warn("identities.file_warning", { detail: `Warning: ${path} ${message}` });
}

function canonicalAdapters(adapters: IdentityAdapters): IdentityAdapters {
  let records: ReturnType<ReturnType<typeof loadAdapters>["installed"]> = [];
  try { records = loadAdapters({ file: barryAdaptersPath() }).installed(); } catch { /* Unknown records are left as written. */ }
  const canonical: IdentityAdapters = {};
  for (const [key, settings] of Object.entries(adapters)) {
    const id = findInstalled(records, key)?.id ?? key;
    if (id !== key && Object.hasOwn(adapters, id)) canonical[key] = settings;
    else canonical[id] = settings;
  }
  return mergeAdapters({}, canonical);
}

/** Shape of `identity.yaml` on disk. */
export interface IdentityYaml {
  /** Persisted numeric identity key; preserves ownership when the name changes. */
  id?: number;
  inherits?: string;
  secrets?: Record<string, import("@barry-rocks/sdk/internal/identities").SecretReference>;
  name: string;
  displayName?: string;
  /**
   * Extra command names this identity answers to, e.g. `bgo` for `bgoode`.
   *
   * Each becomes a shim on PATH beside `barry`. They live here rather than in a
   * central registry so the identity directory stays self-contained — the same
   * reason `bound` is inline.
   */
  aliases?: string[];
  bags?: IdentityBags;
  bounds?: IdentityEntries;
  adapters?: IdentityAdapters;
  tool_discovery?: "provider" | "barry";
  status_notify?: { tool: string; target?: string };
  ui?: string;
  /**
   * Deny rules applied to every session on this Barry, written inline.
   *
   * Named bounds are DB rows a file-based Barry has no id to reference, so the
   * rules live here instead — keeping the directory self-contained. Shape is
   * `Bound`; it merges as one more source in the usual union of denials.
   *
   * `bound:` is what Barry writes; `scope:` is the pre-rename spelling and is
   * read forever. identity.yaml is the user's own file in their own directory
   * — nothing here converts it, so reading only `bound:` would drop the deny
   * rules of every unconverted identity without a word.
   */
  bound?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  /**
   * GitHub App installation this identity answers for. Routing metadata, not
   * config: the webhook receiver reads it to pick whose credentials to use.
   */
  github?: { installationId: number };
  vault?: string;
}



/**
 * Deterministic numeric ID from a Barry name.
 *
 * Uses a 32-bit hash so the same name always produces the same ID. The ID
 * space is offset by 1_000_000_000 to stay well above the auto-increment IDs
 * the database assigns (which start at 1 and grow slowly).
 */
export const SYNTHETIC_ID_OFFSET = 1_000_000_000;

export function syntheticIdFromName(name: string): number {
  const hash = createHash("sha256").update(`barry:${name}`).digest();
  const raw = hash.readUInt32BE(0);
  // Keeps unpersisted files outside the usual small serial range; it is not an ownership marker.
  return SYNTHETIC_ID_OFFSET + (raw % 1_000_000_000);
}

/**
 * Deterministic token from a Barry name.
 */
function syntheticTokenFromName(name: string): string {
  const hash = createHash("sha256").update(`barry-token:${name}`).digest("hex");
  return `prf_${hash.slice(0, 12)}`;
}


/** The config file an identity directory is defined by. */
export const IDENTITY_YAML = "identity.yaml";

/** Read legacy barry.yaml configs for compatibility while always writing identity.yaml; see docs/decisions/0012-credentials-action-runs-and-identity-bags.md. */
export const LEGACY_IDENTITY_YAML = "barry.yaml";
const LEGACY_GRANT_KEY = ["bag", "grant"].join("_");

/**
 * Path to a directory's identity config, preferring the current filename and
 * falling back to the legacy one. Returns `null` when neither is present.
 */
export function findIdentityYamlPath(dir: string): string | null {
  const preferred = join(dir, IDENTITY_YAML);
  if (existsSync(preferred)) return preferred;

  const legacy = join(dir, LEGACY_IDENTITY_YAML);
  if (existsSync(legacy)) return legacy;

  return null;
}


/**
 * Check whether a directory looks like an identity directory (has an
 * `identity.yaml`, or a legacy `barry.yaml`).
 */
export function isIdentityDirectory(dir: string): boolean {
  return findIdentityYamlPath(dir) !== null;
}

/**
 * Read a Barry directory and return a IdentityRecord.
 *
 * A declared ID is retained; otherwise the name supplies a temporary hash ID.
 * This pure reader does not verify ownership. Callers that authenticate or
 * persist an identity must check its row against their authenticated actor.
 *
 * `actorId` is REQUIRED (POL-19): the record carries an `actor_id`, and
 * ownership checks compare it. A silent default of actor 1 — a development
 * row on the author's machine — meant a caller that forgot to pass one
 * attributed the record to an arbitrary actor. Making it explicit forces every
 * caller that returns a record to say whose it is.
 *
 * Throws if the config file is missing or unparseable.
 */
export function loadIdentityFromDirectory(
  identityDir: string,
  options: { actorId: number; sources?: Set<string> },
  seenInherits: Set<string> = new Set(),
): IdentityRecord {
  return readFileIdentity(identityDir, options, seenInherits).record;
}

function readFileIdentity(
  identityDir: string,
  options: { actorId: number; sources?: Set<string> },
  seenInherits: Set<string> = new Set(),
): { record: IdentityRecord; declaredId: number | undefined } {
  const yamlPath = findIdentityYamlPath(identityDir);
  if (!yamlPath) {
    throw new Error(`No ${IDENTITY_YAML} found in ${identityDir}`);
  }

  options.sources?.add(yamlPath);
  let raw: unknown;
  try {
    raw = yamlParse(readFileSync(yamlPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse ${yamlPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid identity config in ${identityDir}: expected a YAML mapping`);
  }

  const yaml = raw as IdentityYaml;
  for (const key of ["env", "env_file"]) {
    if (Object.hasOwn(raw, key)) throw new Error(`Identity ${key} is retired; declare credential references under secrets instead`);
  }
  const name = yaml.name ?? basename(identityDir);
  if (yaml.id !== undefined && (!Number.isSafeInteger(yaml.id) || yaml.id < 1)) throw new Error("identity id must be a positive safe integer");

  // The blocks -> bags rename left no back-compat, so a file still saying
  // `blocks:` loses every grant in it: the key is simply not read, and the
  // identity resolves with no bags at all. That is indistinguishable from an
  // identity that genuinely grants nothing, which is how bux ran for days with
  // 15 bags silently dropped. Say so rather than reading it as empty.
  if (Array.isArray((yaml as { blocks?: unknown }).blocks)) {
    warnIdentityFile(identityDir, `uses the pre-rename "blocks:" key, which is not read. Rename it to "bags:" — until then this identity grants no bags.`);
  }

  const retired = RETIRED_IDENTITY_KEYS.filter(key => Object.hasOwn(raw, key));
  if (retired.length) warnIdentityFile(join(identityDir, "identity.yaml"), `uses ${retired.join(", ")}, which are no longer read. Run \`barry doctor --fix\` to rewrite them as \`adapters:\`.`);
  if (resolve(identityDir) !== getBuiltinIdentityDir()) {
    if (Object.hasOwn(raw, "traits")) {
      warnIdentityFile(yamlPath, "uses `traits:`, which is retired. Run `barry doctor --fix` to migrate to `bags:` and `bounds:`.");
    }
    if (Object.hasOwn(raw, LEGACY_GRANT_KEY)) {
      warnIdentityFile(yamlPath, `uses \`${LEGACY_GRANT_KEY}:\`, which is retired. Run \`barry doctor --fix\` to migrate.`);
    }
  }
  const adapters = yaml.adapters === undefined ? undefined : IdentityAdaptersSchema.safeParse(yaml.adapters);
  if (adapters && !adapters.success) throw new Error(`Invalid adapters in ${identityDir}: ${adapters.error.message}`);

  let metadata: IdentityMetadata = {};
  if (yaml.inherits) metadata.inherits = yaml.inherits;
  if (yaml.displayName) metadata.display_name = yaml.displayName;
  if (yaml.aliases && yaml.aliases.length > 0) metadata.aliases = yaml.aliases;
  if (yaml.secrets) metadata.secrets = bindSecretReferences(yaml.secrets, resolve(identityDir));
  let rawBagsForParse: unknown = yaml.bags;
  if (Array.isArray(yaml.bags)) {
    let hadNestedExtensions = false;
    rawBagsForParse = yaml.bags.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || "name" in entry) return entry;
      const entries = Object.entries(entry as Record<string, unknown>);
      if (entries.length !== 1) return entry;
      const [bagName, val] = entries[0];
      if (val && typeof val === "object" && !Array.isArray(val) && "extensions" in val) {
        hadNestedExtensions = true;
        const { extensions: _ignored, ...rest } = val as Record<string, unknown>;
        return Object.keys(rest).length > 0 ? { [bagName]: rest } : bagName;
      }
      return entry;
    });
    if (hadNestedExtensions && resolve(identityDir) !== getBuiltinIdentityDir()) {
      warnIdentityFile(
        yamlPath,
        "uses `extensions:` inside `bags:`, which is retired. Run `barry doctor --fix` to migrate to standalone bags.",
      );
    }
  }
  const selectedBags = parseIdentityBags(rawBagsForParse);
  if (selectedBags.bags.length) metadata.bags = selectedBags.bags;
  if (Object.keys(selectedBags.bag_configs).length) metadata.bag_configs = selectedBags.bag_configs;
  const baseDir = getBuiltinIdentityDir();
  const base = baseDir && findIdentityYamlPath(baseDir) && resolve(identityDir) !== resolve(baseDir) ? loadIdentityFromDirectory(baseDir, options).metadata : undefined;
  const ownBounds = inheritEntries([], parseBounds(yaml.bounds, yamlPath), parseBounds(base?.bounds).map(entry => entry.name), yamlPath);
  if (ownBounds.length) metadata.bounds = serializeEntries(ownBounds);
  if (adapters?.success) metadata.adapters = canonicalAdapters(adapters.data);
  if (yaml.tool_discovery) metadata.tool_discovery = yaml.tool_discovery;
  if (yaml.status_notify?.tool) metadata.status_notify = yaml.status_notify;
  if (yaml.ui) metadata.ui = yaml.ui;
  const unqualifiedBound = yaml.bound ?? yaml.scope;
  if (unqualifiedBound && Object.keys(unqualifiedBound).length > 0) {
    metadata.bound = unqualifiedBound;
    warnIdentityFile(yamlPath, "writes restrictions inline under `bound:`. Run `barry doctor --fix` to move them into `bounds:`");
  }
  if (yaml.vault !== undefined) metadata.vault = parseVaultName(yaml.vault);
  if (yaml.github) metadata.github = yaml.github;

  if (yaml.inherits) {
    if (seenInherits.has(name)) {
      throw new Error(`Circular inheritance detected in identity "${name}"`);
    }
    const nextSeen = new Set(seenInherits);
    nextSeen.add(name);
    if (nextSeen.has(yaml.inherits)) {
      throw new Error(`Circular inheritance detected: "${name}" inherits "${yaml.inherits}"`);
    }
    const parentDir = findIdentityDirectoryByName(yaml.inherits);
    if (!parentDir) {
      throw new Error(`Parent identity "${yaml.inherits}" not found for "${name}"`);
    }
    const parentRecord = loadIdentityFromDirectory(parentDir, options, nextSeen);
    metadata = mergeInheritedIdentity(parentRecord.metadata, metadata) as IdentityMetadata;
    metadata.inherits = yaml.inherits;
  }

  const actorId = options.actorId;

  return {
    declaredId: yaml.id,
    record: {
      id: yaml.id ?? syntheticIdFromName(name),
      token: syntheticTokenFromName(name),
      actor_id: actorId,
      name,
      metadata,
      created_at: new Date().toISOString(),
      last_used_at: null,
    },
  };
}

export async function loadOwnedIdentityFromDirectory(
  identityDir: string,
  actorId: number,
  options: { expectedId?: number } = {},
): Promise<IdentityRecord | null> {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) return null;
  const { record, declaredId } = readFileIdentity(identityDir, { actorId });
  const { getIdentity, getIdentityByName } = await import("./identities.js");
  const row = declaredId === undefined ? await getIdentityByName(actorId, record.name) : await getIdentity(declaredId);
  if (declaredId !== undefined && (!row || row.id !== declaredId || row.actor_id !== actorId)) return null;
  if (row && row.actor_id !== actorId) return null;
  if (options.expectedId !== undefined && row?.id !== options.expectedId) return null;
  return row ? { ...record, id: row.id, token: row.token, created_at: row.created_at, last_used_at: row.last_used_at } : record;
}

/** `~/.barry/identities.yaml` — name → directory for Identities outside `~/.barry/identities`. */
export function readIdentitiesRegistry(): Record<string, string> {
  // The registry moved with the barrys → identities rename. The pre-rename file
  // is still read when the new one is absent, so an existing install keeps
  // working without a migration step; writes always go to the new path.
  const path = existsSync(getIdentitiesRegistryPath())
    ? getIdentitiesRegistryPath()
    : getLegacyIdentitiesRegistryPath();

  if (!existsSync(path)) return {};
  try {
    return (yamlParse(readFileSync(path, "utf-8")) as Record<string, string>) ?? {};
  } catch {
    // A corrupt registry must not hide the identities in the well-known directory
    return {};
  }
}

/** The base identity's name, reserved: the repository root's `identity.yaml`. */
export const BASE_IDENTITY = "base";
export const LEGACY_BASE_IDENTITY = "barry";

export function isReservedIdentityName(name: string): boolean {
  return name === BASE_IDENTITY || name === LEGACY_BASE_IDENTITY;
}

/** Register a Barry directory that lives outside `~/.barry/identities`. */
export function registerIdentityDirectory(name: string, dir: string): void {
  if (isReservedIdentityName(name)) {
    throw new Error(`Identity name "${name}" is reserved for the base identity Barry ships`);
  }
  const registry = readIdentitiesRegistry();
  registry[name] = dir.replace(homedir(), "~");
  const path = getIdentitiesRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(registry), "utf-8");
}

/** Forget a registered identity directory. The directory itself is left as it is. */
export function unregisterIdentityDirectory(name: string): void {
  const registry = readIdentitiesRegistry();
  if (!Object.hasOwn(registry, name)) return;
  delete registry[name];
  const path = getIdentitiesRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yamlStringify(registry), "utf-8");
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Every Barry directory: the ones under `~/.barry/identities/` plus any registered
 * in `~/.barry/identities.yaml`. Returns absolute paths, well-known directory
 * first, deduplicated — a registry entry pointing back into the well-known
 * directory must not yield the same Barry twice.
 */
export function listIdentityDirectoryPaths(options: { includeBuiltin?: boolean } = {}): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  if (options.includeBuiltin ?? true) {
    const builtin = getBuiltinIdentityDir();
    if (builtin && !seen.has(builtin) && isIdentityDirectory(builtin)) {
      dirs.push(builtin);
      seen.add(builtin);
    }
  }

  // Both the current well-known directory and the pre-rename one, so an install
  // that predates the rename still finds its identities.
  for (const root of [getIdentitiesDir(), getLegacyIdentitiesDir()]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      if (!seen.has(dir) && isIdentityDirectory(dir)) {
        dirs.push(dir);
        seen.add(dir);
      }
    }
  }

  for (const registered of Object.values(readIdentitiesRegistry())) {
    const dir = expandHome(registered);
    // A registered path that has been moved or deleted is skipped rather than
    // fatal: one stale entry must not blank the whole listing.
    if (!seen.has(dir) && isIdentityDirectory(dir)) {
      dirs.push(dir);
      seen.add(dir);
    }
  }

  return dirs;
}

/**
 * Load every Barry directory — `~/.barry/identities/` plus registered paths.
 *
 * Skips directories without an identity config and any whose YAML fails to
 * parse — one malformed Barry must not hide the rest from the listing.
 */
export function listIdentityDirectories(options: { actorId: number }): IdentityRecord[] {
  const records: IdentityRecord[] = [];
  for (const dir of listIdentityDirectoryPaths()) {
    try {
      records.push(loadIdentityFromDirectory(dir, options));
    } catch {
      // A single unparseable identity config shouldn't blank the whole list
    }
  }
  return records;
}

/**
 * Find the Barry directory whose name matches `target`.
 *
 * Walks every known identity directory (well-known + registry) and compares
 * the `name` field from its YAML (falling back to the directory basename).
 * Returns the absolute directory path, or null when no directory matches.
 */
export function findIdentityDirectoryByName(target: string): string | null {
  const builtin = getBuiltinIdentityDir();
  for (const dir of listIdentityDirectoryPaths()) {
    try {
      const yamlPath = findIdentityYamlPath(dir);
      if (!yamlPath) continue;
      const yaml = yamlParse(readFileSync(yamlPath, "utf-8")) as IdentityYaml;
      const name = yaml?.name ?? basename(dir);
      const isBaseMatch = (target === BASE_IDENTITY || target === LEGACY_BASE_IDENTITY) &&
        (name === BASE_IDENTITY || name === LEGACY_BASE_IDENTITY || (builtin !== null && dir === builtin));
      if (name === target || isBaseMatch) {
        if (isReservedIdentityName(target) && builtin && dir !== builtin) {
          throw new Error(`User identity at "${dir}" attempts to shadow the reserved base identity "${BASE_IDENTITY}"`);
        }
        return dir;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("shadow the reserved base identity")) {
        throw err;
      }
      // Unparseable — can't match it, keep looking
    }
  }
  return null;
}

/**
 * Find the Barry directory whose name hashes to `id`.
 *
 * `syntheticIdFromName` is one-way, so the only way back is to hash every
 * name and compare. Returns null when no directory matches.
 */
export function findIdentityDirectoryById(id: number): string | null {
  for (const dir of listIdentityDirectoryPaths()) {
    // The name inside identity.yaml wins over the directory name — that's what
    // loadIdentityFromDirectory hashes.
    try {
      const yamlPath = findIdentityYamlPath(dir);
      if (!yamlPath) continue;
      const yaml = yamlParse(readFileSync(yamlPath, "utf-8")) as IdentityYaml;
      const name = yaml?.name ?? basename(dir);
      if (yaml.id === id || yaml.id === undefined && syntheticIdFromName(name) === id) return dir;
    } catch {
      // Unparseable — can't match it, keep looking
    }
  }
  return null;
}

function assertSecretReferenceUpdates(updates: Record<string, unknown>): void {
  if (updates.vault !== undefined) parseVaultName(updates.vault);
  for (const key of ["env", "env_file"]) {
    if (Object.hasOwn(updates, key) && updates[key] !== undefined) {
      throw new Error(`Identity ${key} is retired; declare credential references under secrets instead`);
    }
  }
}

/**
 * Merge `updates` into an identity's `identity.yaml`, preserving unknown keys.
 *
 * Writes through a temp file + rename so a crash mid-write can't leave a
 * truncated config behind. Keys set to `undefined` are deleted, which is how
 * callers clear adapter settings.
 *
 * A directory still on the legacy `barry.yaml` is migrated here rather than
 * rewritten in place: the merged config is written to `identity.yaml` and the
 * old file removed, so the first write after upgrading moves it forward. That
 * only happens once, and reads tolerate either name in the meantime.
 */
export function writeIdentityYaml(identityDir: string, updates: Partial<IdentityYaml> & Record<string, unknown>): void {
  assertSecretReferenceUpdates(updates);
  const sourcePath = findIdentityYamlPath(identityDir);
  if (!sourcePath) {
    throw new Error(`No ${IDENTITY_YAML} found in ${identityDir}`);
  }

  let existing: IdentityYaml;
  try {
    existing = (yamlParse(readFileSync(sourcePath, "utf-8")) ?? {}) as IdentityYaml;
  } catch (err) {
    throw new Error(
      `Failed to parse ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  const targetPath = join(identityDir, IDENTITY_YAML);
  const tmpPath = join(identityDir, `.${IDENTITY_YAML}.tmp`);
  writeFileSync(tmpPath, yamlStringify(merged), "utf-8");
  renameSync(tmpPath, targetPath);

  // Migrated off the legacy name — drop it so the directory has one config.
  if (sourcePath !== targetPath) {
    try {
      unlinkSync(sourcePath);
    } catch {
      // Leaving the old file behind is harmless: identity.yaml wins on read.
    }
  }
}

/**
 * Scaffold a new identity directory under `~/.barry/identities/<name>/`.
 *
 * Mirrors what `barry heir` creates: the config, a gitignored `.env`, and an
 * empty `bags/` directory. Throws if the directory already exists so a
 * create never silently overwrites an existing identity — including one still
 * on the legacy config filename.
 */
export function createIdentityDirectory(
  name: string,
  config: Partial<IdentityYaml> = {},
  options: { dir?: string } = {},
): string {
  if (isReservedIdentityName(name)) {
    throw new Error(`Identity name "${name}" is reserved for the base identity Barry ships`);
  }
  const dir = options.dir ?? getIdentityDir(name);
  if (isIdentityDirectory(dir)) {
    throw new Error(`Identity "${name}" already exists at ${dir}`);
  }

  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "bags"), { recursive: true });

  const yaml: Record<string, unknown> = {
    name,
    inherits: config.inherits !== undefined ? config.inherits : BASE_IDENTITY,
  };
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && key !== "name" && key !== "inherits") yaml[key] = value;
  }

  writeFileSync(join(dir, IDENTITY_YAML), yamlStringify(yaml), "utf-8");
  writeFileSync(join(dir, ".gitignore"), ".env\nnode_modules/\n", "utf-8");
  writeFileSync(
    join(dir, ".env"),
    `# Secrets for ${name}\n# Add API keys and tokens here — this file is gitignored\n`,
    "utf-8",
  );

  // Directories under ~/.barry/identities are found by scanning; anywhere else has
  // to be recorded, or the Barry is invisible to `switch`, the API and My Identities.
  if (dirname(dir) !== getIdentitiesDir()) registerIdentityDirectory(name, dir);

  return dir;
}


/**
 * The `identities` row id to store for this Barry.
 *
 * Unpersisted file hashes cannot own session resources. Sync the file to its
 * canonical row and verify the actor; database-only identities also require
 * an existing owned row, regardless of their numeric range.
 */
export async function resolveForeignKeyId(
  barry: IdentityRecord,
  options: { actorId?: number } = {},
): Promise<number | null> {
  const actorId = options.actorId ?? barry.actor_id;
  if (!Number.isSafeInteger(actorId) || actorId <= 0 || actorId !== barry.actor_id || !Number.isSafeInteger(barry.id) || barry.id <= 0) return null;

  // Discovery-wide resolution, not just the well-known path: identities can
  // live in the legacy root or anywhere the registry points (`barry heir`
  // creates them in arbitrary directories). Resolving only
  // `~/.barry/identities/<name>` made every registry-registered Barry
  // invisible here, so their sessions could never be matched back to a row —
  // and both identities on this machine are registry-registered.
  const dir = findIdentityDirectoryById(barry.id);
  if (!dir) {
    const { getIdentity } = await import("./identities.js");
    const row = await getIdentity(barry.id);
    return row?.actor_id === actorId ? row.id : null;
  }

  try {
    const { identityId } = await syncIdentityToDbIfChanged(dir, { actorId });
    return identityId;
  } catch {
    // Without a cache row there's no id the FK accepts; the caller stores null
    // rather than failing the whole session.
    return null;
  }
}

/**
 * The metadata payload a disk→DB sync must send.
 *
 * Collection-shaped keys (bags, bounds) are pinned to explicit empty arrays when
 * absent: the row update is a JSON MERGE, so only a present key can clear a
 * stale value. Without this, "remove the last bag" is the one edit that can
 * never propagate — an asymmetry invisible until someone disables something.
 */
export function syncMetadataPayload(metadata: IdentityMetadata): IdentityMetadata {
  return {
    ...metadata,
    bags: metadata.bags ?? [],
    bag_configs: metadata.bag_configs ?? {},
    secrets: metadata.secrets ?? {},
    bounds: metadata.bounds ?? [],
  };
}

interface IdentitySyncStamp {
  version: number; identityId: number; actorId: number; name: string; row: string; base: string | null;
  inputs: Array<{ path: string; stamp: string }>;
}
function inputStamp(path: string): string {
  try { const st = statSync(path); return `${st.mtimeMs}:${st.size}`; } catch { return "-"; }
}
function identityRowStamp(row: IdentityRecord): string {
  return createHash("sha256").update(JSON.stringify([row.name, row.actor_id, FILE_OWNED_FIELDS.map(field => row.metadata[field])])).digest("hex");
}
/** Skip YAML parsing and durable writes while every authored input and cache row agree. */
export async function syncIdentityToDbIfChanged(identityDir: string, options: { actorId: number; expectedId?: number }): Promise<{ identityId: number; synced: boolean }> {
  const directory = resolve(identityDir);
  if (options.expectedId !== undefined && !listIdentityDirectoryPaths().some(path => resolve(path) === directory)) throw new Error("identity file no longer matches this CLI binding; regenerate this CLI");
  const cacheDir = join(barryCacheDir(), "identity-sync");
  const file = join(cacheDir, `${createHash("sha256").update(directory).digest("hex")}.json`);
  const { getIdentity } = await import("./identities.js");
  let cached: IdentitySyncStamp | undefined;
  try { cached = JSON.parse(readFileSync(file, "utf8")) as IdentitySyncStamp; } catch { /* First sync or purged cache. */ }
  if (cached?.version === 2 && cached.actorId === options.actorId && cached.base === getBuiltinIdentityDir() && (options.expectedId === undefined || cached.identityId === options.expectedId) && Array.isArray(cached.inputs) && cached.inputs.length > 0 && cached.inputs.every(input => inputStamp(input.path) === input.stamp)) {
    const row = await getIdentity(cached.identityId);
    if (row?.actor_id === options.actorId && identityRowStamp(row) === cached.row) return { identityId: cached.identityId, synced: false };
  }
  // Validate a generated binding before a sync can retarget it to another row.
  if (options.expectedId !== undefined) {
    const { record } = readFileIdentity(directory, options);
    if (record.id !== options.expectedId) throw new Error("identity file no longer matches this CLI binding; regenerate this CLI");
  }
  const sources = new Set<string>();
  const result = await syncIdentityToDb(directory, { actorId: options.actorId, sources });
  const row = await getIdentity(result.identityId);
  if (!row || row.actor_id !== options.actorId) throw new Error("identity sync no longer resolves to its owner");
  const inputs = [...sources, getIdentitiesRegistryPath(), getLegacyIdentitiesRegistryPath(), getIdentitiesDir(), getLegacyIdentitiesDir()].flatMap(path => [path, dirname(path)]).map(path => ({ path, stamp: inputStamp(path) }));
  inputs.push(...bagLoadInputs(row.metadata.bags ?? []));
  const stamp: IdentitySyncStamp = { version: 2, identityId: row.id, actorId: options.actorId, name: row.name, row: identityRowStamp(row), base: getBuiltinIdentityDir(), inputs };
  mkdirSync(cacheDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(stamp), { mode: 0o600 });
  renameSync(temporary, file);
  return result;
}

export async function syncIdentityToDb(
  identityDir: string,
  options: { actorId: number; sources?: Set<string> },
): Promise<{ identityId: number; synced: boolean }> {
  const { record, declaredId: fileId } = readFileIdentity(identityDir, options);
  // The shipped identity's file is checked in and shared by every machine,
  // while row ids are per machine. It is found by its reserved name, and no
  // id is written back to it.
  const shipped = resolve(identityDir) === getBuiltinIdentityDir();
  const declaredId = shipped ? undefined : fileId;

  // Dynamic imports to avoid pulling in DB at module-load time.
  // The reader functions above are pure and usable without a DB.
  const { getIdentity, getIdentityByName, renameIdentity, createIdentity, updateIdentityMetadataInRow, setIdentityMetadataFieldInRow } =
    await import("./identities.js");

  const pinned = declaredId === undefined ? undefined : await getIdentity(declaredId);
  if (pinned && pinned.actor_id !== record.actor_id) throw new Error("identity file id belongs to another actor");
  if (declaredId !== undefined && !pinned) throw new Error("identity file's pinned row is missing; refusing to reassign ownership");
  const existing = pinned ?? await getIdentityByName(record.actor_id, record.name);
  if (pinned && pinned.name !== record.name) await renameIdentity(pinned.id, record.name);

  if (existing) {
    // Mirror disk to the cache row — via syncMetadataPayload, because the
    // loader drops empty arrays from metadata (`bags: []` becomes an absent
    // key) and updateIdentityMetadata MERGES JSON, so an absent key preserves
    // the stale row value.
    const payload = syncMetadataPayload(record.metadata);
    await updateIdentityMetadataInRow(existing.id, payload);
    // The merge cannot REMOVE a key, so a file-owned field deleted from the
    // yaml (an unset adapter setting, a dropped vault) survived in the row while
    // `barry doctor --fix` reported it repaired. Delete those explicitly — only
    // file-owned ones: any other row key is not the file's to take away.
    for (const field of FILE_OWNED_FIELDS) {
      if (payload[field] === undefined && existing.metadata[field] !== undefined) {
        await setIdentityMetadataFieldInRow(existing.id, field, undefined);
      }
    }

    if (!shipped && record.id !== existing.id) writeIdentityYaml(identityDir, { id: existing.id });
    invalidateIdentityEnvironment(existing.id);
    return { identityId: existing.id, synced: true };
  }

  const created = await createIdentity({
    actor_id: record.actor_id,
    name: record.name,
    metadata: record.metadata,
  });

  if (!shipped) writeIdentityYaml(identityDir, { id: created.id });
  invalidateIdentityEnvironment(created.id);
  return { identityId: created.id, synced: true };
}

/**
 * Metadata keys whose `identity.yaml` field is spelled differently. A write
 * under the metadata spelling lands on a key the loader never reads — stored,
 * reported as success, and ignored.
 */
const YAML_KEY_BY_METADATA: Record<string, string> = {
  display_name: "displayName",
};

/** Enough of an identity to route a write: which one, and whose. */
export type IdentityRef = Pick<IdentityRecord, "id" | "name" | "actor_id">;

/**
 * Change an identity's configuration where it actually lives.
 *
 * THE write path for identity metadata. An identity with a directory keeps its
 * config in `identity.yaml`, and its DB row is a cache rebuilt from the file at
 * every session start (`syncIdentityToDb`), so a row-only write reports success
 * and is silently reverted. That happened four times — `vault set-env`, `pack`,
 * `unpack`, `env migrate` — each a command that reached for the row writer.
 * This routes by backing store so a caller cannot pick the wrong one; the
 * row writers on `Identities` refuse file-owned fields for a directory-backed
 * identity (see `assertRowOwnsFields` in identities.ts).
 *
 * `undefined` removes a key. Returns where the change went.
 */
export async function updateIdentity(
  identity: IdentityRef,
  updates: Partial<IdentityMetadata> & Record<string, unknown>,
): Promise<"file" | "row"> {
  assertSecretReferenceUpdates(updates);
  const dir = findIdentityDirectoryByName(identity.name);
  if (!dir) {
    // A DB-only identity: the row IS the source of truth.
    const { setIdentityMetadataFieldInRow } = await import("./identities.js");
    for (const [key, value] of Object.entries(updates)) {
      await setIdentityMetadataFieldInRow(identity.id, key, value);
    }
    return "row";
  }

  const ownYaml = yamlParse(readFileSync(findIdentityYamlPath(dir)!, "utf-8")) as IdentityYaml;
  /**
   * `bags` and `bounds` are UNIONED with the parent's (mergeInheritedIdentity),
   * and callers hand this the resolved list — `pack` reads the merged record,
   * appends, and writes it back. Written verbatim, every inherited entry was
   * frozen into the child's file: packing one bag onto an identity that
   * inherits the base copied all fourteen of its bags into it, so the parent
   * could never again change what the child gets. Keep only what the parent
   * does not already provide.
   */
  const parentDir = ownYaml.inherits ? findIdentityDirectoryByName(ownYaml.inherits) : undefined;
  const parent = parentDir ? loadIdentityFromDirectory(parentDir, { actorId: identity.actor_id }).metadata : undefined;
  const ownOnly = (key: "bags", values: readonly string[], keep: (name: string) => boolean = () => false) =>
    values.filter((name) => keep(name) || !(parent?.[key] ?? []).includes(name));

  const yamlUpdates: Record<string, unknown> = {};
  if (Object.hasOwn(updates, "bags") || Object.hasOwn(updates, "bag_configs")) {
    const current = parseIdentityBags(ownYaml.bags);
    const bags = Object.hasOwn(updates, "bags") ? updates.bags ?? [] : current.bags;
    const configurations = Object.fromEntries(
      Object.entries(Object.hasOwn(updates, "bag_configs") ? updates.bag_configs ?? {} : current.bag_configs).filter(([name]) => bags.includes(name)),
    );
    // A bag this identity configures stays listed even when inherited: the
    // override lives on the entry.
    yamlUpdates.bags = serializeIdentityBags(ownOnly("bags", bags, (name) => Object.hasOwn(configurations, name)), configurations);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (key === "bags" || key === "bag_configs") continue;
    if (key === "adapters") {
      const own = value === undefined ? {} : ownAdapters(parent?.adapters ?? {}, canonicalAdapters(value as IdentityAdapters));
      yamlUpdates.adapters = Object.keys(own).length ? own : undefined;
      for (const retired of RETIRED_IDENTITY_KEYS) yamlUpdates[retired] = undefined;
      continue;
    }
    if (key === "bounds") {
      yamlUpdates.bounds = serializeEntries(ownEntries(parseBounds(ownYaml.bounds), parseBounds(parent?.bounds), value == null ? null : value as string[]));
      continue;
    }
    if (key === "secrets") {
      yamlUpdates.secrets = value === undefined ? undefined : Object.fromEntries(Object.entries(mergeSecretBindings({}, value as import("@barry-rocks/sdk/internal/identities").SecretBindings)).map(([name, binding]) => [name, binding.reference]));
      continue;
    }
    yamlUpdates[YAML_KEY_BY_METADATA[key] ?? key] = value;
  }
  writeIdentityYaml(dir, yamlUpdates);

  // Refresh the cache now rather than at the next session start, so readers of
  // the row agree immediately. Best-effort: the file is already the truth.
  try {
    await syncIdentityToDb(dir, { actorId: identity.actor_id });
  } catch (err) {
    diagnostics.warn("identities.cache_refresh_failed", { detail: `warning: ${IDENTITY_YAML} updated, but its cached row was not refreshed: ${err instanceof Error ? err.message : String(err)}` });
  }
  return "file";
}

/**
 * Fields a file-based identity's `identity.yaml` owns. The DB row only caches these,
 * so a disagreement means the row is stale.
 */
export const FILE_OWNED_FIELDS = [
  "display_name",
  "adapters",
  ...RETIRED_IDENTITY_KEYS,
  "bags",
  "bag_configs",
  "secrets",
  "traits",
  "bounds",
  "bound_id",
  "bound",
  "github",
  // Remove retired cached credentials when refreshing a file-backed row.
  "env",
  "env_file",
  "vault",
  "ui",
] as const;

export interface BarryFieldDrift {
  field: string;
  file: unknown;
  db: unknown;
}

/**
 * Order-independent structural stringify.
 *
 * Plain `JSON.stringify` is key-order sensitive; the two objects being
 * compared here come from different serializers (YAML on disk, JSON in the
 * row) that make no promise of matching key order for an
 * otherwise-identical object. Without this, `env` — a map of reference
 * objects like `{source, item, field}` — could not be added to
 * `FILE_OWNED_FIELDS` without risking a false "drifted" report on every
 * identity whose two copies simply serialized their keys differently.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * An empty map is no map: the yaml loader leaves `bag_configs` out when it has
 * none while the row stores `{}`, which read as drift on every identity
 * without bag configs.
 */
function absent(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (absent(a) && absent(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.map(stableStringify).sort().join("\n") === b.map(stableStringify).sort().join("\n");
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    return stableStringify(a) === stableStringify(b);
  }
  return a === b;
}

/**
 * Compare an identity's database row against its `identity.yaml`.
 *
 * The directory wins on read, so a stale row is invisible until something
 * resolves by id rather than by name — which is how a Barry can run for weeks
 * on config its yaml never named. Returns an empty array when the Barry has no
 * directory, since then the row is the only source and cannot disagree.
 */
export function findIdentityDrift(row: IdentityRecord, actorId?: number): BarryFieldDrift[] {
  // Resolve through the registry, not just the well-known path. `heir` creates
  // identities beside your other repos, so an identity living outside
  // ~/.barry/barrys/ was skipped entirely — reported as "no drift" for a file
  // this never read.
  let dir = getIdentityDir(row.name);
  if (!isIdentityDirectory(dir)) {
    // Match by name, not by id. A row reaching here carries a DB serial, and
    // `findIdentityDirectoryById` compares against synthetic ids (>= 1e9) — a
    // serial can never equal one, so every registered identity resolved to null
    // and reported "no drift" no matter how far its row had slid. Name is what
    // both sources agree on; the id spaces do not overlap.
    const resolved = findIdentityDirectoryByName(row.name);
    if (!resolved) return [];
    dir = resolved;
  }

  let fileRecord: IdentityRecord;
  try {
    // The file belongs to the same actor as the row it is compared against,
    // so the row's actor names the read (POL-19: no silent actor-1 default).
    fileRecord = loadIdentityFromDirectory(dir, { actorId: actorId ?? row.actor_id });
  } catch (err) {
    // Unreadable yaml is worse than drift, not separate from it: the Barry has
    // a directory that wins on read and cannot be read, so report it here
    // rather than letting a silent skip pass as "no drift".
    return [{
      field: IDENTITY_YAML,
      file: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
      db: "(row in use)",
    }];
  }

  return FILE_OWNED_FIELDS.flatMap((field) => {
    const file = fileRecord.metadata[field];
    const db = row.metadata[field];
    return sameValue(file, db) ? [] : [{ field, file, db }];
  });
}

const baseConfigs = new Map<string, ReturnType<typeof resolveIdentityConfig>>();
export function baseIdentityConfig() {
  const dir = getBuiltinIdentityDir();
  if (!dir || !findIdentityYamlPath(dir)) return undefined;
  let config = baseConfigs.get(dir);
  if (!config) {
    // The shipped base is a per-installation template, read for its METADATA
    // alone — the result is a ResolvedIdentityConfig that carries no
    // `actor_id`, so the actor named here never escapes as ownership. POL-19
    // made the reader require one rather than silently defaulting to actor 1;
    // this base read names it explicitly to document that it is inert.
    config = resolveIdentityConfig(loadIdentityFromDirectory(dir, { actorId: BASE_TEMPLATE_ACTOR }).metadata);
    baseConfigs.set(dir, config);
  }
  return config;
}
