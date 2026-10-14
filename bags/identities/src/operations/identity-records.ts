import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath } from "@barry-rocks/sdk/services";
/**
 * Identity records: the rows and directories behind the identities subject,
 * for the processes that host this bag and act with the installation's
 * authority (a session row names its identity by id; a command needs the
 * directory it acts in). Anything that asks on someone's behalf goes through
 * `Barry` instead, which decides what that caller may do.
 *
 * An identity is a directory. Its row caches the file and gives sessions an id
 * to reference; an identity with no directory can be read and removed, never
 * created or changed.
 */
import { readFileSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import { dirname, join, resolve } from "node:path";
import { BarryError, type Caller, type IdentityReference, type Warning } from "@barry-rocks/sdk";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { parseTraits, parseBounds, serializeEntries, type BoundEntry, defaultHarness, IdentityChangesSchema, RETIRED_IDENTITY_KEYS, type RetiredIdentityKeys, type IdentityAdapters, type IdentityChanges } from "@barry-rocks/sdk/internal/identities";
import { Identities, resolveIdentityConfig, type IdentityMetadata, type IdentityRecord } from "../store/identities.js";
import { Users, type UserRecord } from "../store/users.js";
import { bounds } from "./bounds.js";
import { resolveHarnessNames } from "@barry-rocks/sdk/internal/traits";
import { baseIdentityConfig, loadIdentityFromDirectory } from "../store/identity-files.js";
import { Traits } from "../config/traits.js";
import {
  findIdentityYamlPath,
  findIdentityDirectoryById,
  findIdentityDirectoryByName,
  isIdentityDirectory,
  listIdentityDirectories,
  loadOwnedIdentityFromDirectory,
  findIdentityDrift,
  resolveForeignKeyId,
  syncIdentityToDb,
  syntheticIdFromName,
  writeIdentityYaml,
} from "../store/identity-files.js";
import { resolveAndSyncBags, UnregisteredBagError, type BagSyncWarning } from "../store/identity-bags.js";
import {
  describeIdentitySource,
  findGitRoot,
  readRepoIdentityDefault,
  resolveSessionIdentity,
  type ResolvedSessionIdentity,
} from "../store/identity-resolution.js";
import { getBuiltinIdentityDir, getIdentitiesDir, getIdentityDir } from "../paths.js";
import { isKnownModelFor, knownHarness } from "../model-catalog.js";
import { hasIdentityGrant } from "@barry-rocks/sdk/internal/auth";

/** Which identity: its row id (or a directory's synthetic id), or its name. */
export type IdentityRef = { readonly id: number } | { readonly name: string };

/** An identity as the records hold it: the row, where it lives, and whether it is the default. */
export interface IdentityEntry {
  record: IdentityRecord;
  source: "file" | "db";
  /** The identity's directory, or null for a row with none. */
  dir: string | null;
  isDefault: boolean;
}

export function refOf(ref: IdentityReference): IdentityRef {
  return typeof ref === "number" ? { id: ref } : { name: ref };
}

export function refName(ref: IdentityRef): string {
  return "name" in ref ? `"${ref.name}"` : `id ${ref.id}`;
}

/** The user a caller acts for: the device's actor, or the installation owner. */
export async function userOf(caller: Caller): Promise<UserRecord> {
  const actorId = caller.kind === "device" ? caller.principal.actorId : caller.kind === "owner" ? caller.actorId : undefined;
  const user = actorId === undefined ? await Users.getInstallationOwner() : await Users.get(actorId);
  if (!user) throw new BarryError("not_found", "No Barry user is configured", "Run barry setup");
  return user;
}

export function activeName(user: UserRecord): string | null {
  return typeof user.settings.defaultBarry === "string" ? user.settings.defaultBarry : null;
}

/**
 * Find an identity the actor owns, from whichever store holds it. A row can
 * still name a directory identity (its cache row), so the directory is looked
 * for first and wins: a change to the cache would be reverted by the next sync.
 */
export async function locate(ref: IdentityRef, actorId: number): Promise<{ record: IdentityRecord; dir: string | null } | null> {
  if ("name" in ref) {
    const dir = findIdentityDirectoryByName(ref.name);
    if (dir) {
      try {
        const record = await loadOwnedIdentityFromDirectory(dir, actorId);
        return record ? { record, dir } : null;
      } catch {
        return null;
      }
    }
    const row = await Identities.getByName(actorId, ref.name);
    return row ? { record: row, dir: null } : null;
  }
  const row = await Identities.get(ref.id);
  if (row && row.actor_id !== actorId) return null;
  const namedDir = row ? getIdentityDir(row.name) : null;
  const dir = findIdentityDirectoryById(ref.id)
    ?? (namedDir && isIdentityDirectory(namedDir) ? namedDir : row ? findIdentityDirectoryByName(row.name) : null);
  if (dir) {
    try {
      const owned = await loadOwnedIdentityFromDirectory(dir, actorId, row ? { expectedId: row.id } : {});
      return owned ? { record: owned, dir } : null;
    } catch {
      return null;
    }
  }
  return row ? { record: row, dir: null } : null;
}

/** The row id a stored reference names when it is not a name: a row id, or this node's stable id for the identity. */
function storedId(reference: string): number | null {
  if (/^[1-9][0-9]*$/.test(reference)) return Number(reference);
  try {
    return installationRegistry().legacyIdentityId(reference);
  } catch (error) {
    if (error instanceof Error && error.message === "unknown local identity") return null;
    throw error;
  }
}

/**
 * `locate`, or a refusal naming what was asked for. A name that names no
 * identity is tried as the other references a schedule or a one-off stores:
 * a row id, or this node's stable id for the identity.
 */
export async function located(ref: IdentityRef, user: UserRecord): Promise<{ record: IdentityRecord; dir: string | null }> {
  let found = await locate(ref, user.id);
  if (!found && "name" in ref) {
    const id = storedId(ref.name);
    if (id !== null) found = await locate({ id }, user.id);
  }
  if (!found) throw new BarryError("not_found", `Identity ${refName(ref)} not found`);
  return found;
}

export function entry(found: { record: IdentityRecord; dir: string | null }, user: UserRecord): IdentityEntry {
  return { record: found.record, source: found.dir ? "file" : "db", dir: found.dir, isDefault: found.record.name === activeName(user) };
}

/** Every identity the user has: directories first, then rows no directory shadows. */
export async function entries(user: UserRecord): Promise<IdentityEntry[]> {
  const directories = listIdentityDirectories({ actorId: user.id });
  const names = new Set(directories.map((record) => record.name));
  const found = [
    ...directories.map((record) => ({ record, dir: findIdentityDirectoryByName(record.name) })),
    ...(await Identities.listAll())
      .filter((record) => record.actor_id === user.id && !names.has(record.name))
      .map((record) => ({ record, dir: null })),
  ];
  return found.map((item) => entry(item, user));
}

function bagWarnings(warnings: readonly BagSyncWarning[]): Warning[] {
  return warnings.map((w) => ({ kind: w.kind, bag: w.bag, message: w.message, ...(w.hint ? { hint: w.hint } : {}) }));
}

/** A change, checked against IdentityChangesSchema: a misspelt key or a malformed value is refused. */
export function parseChanges(changes: unknown): IdentityChanges {
  const parsed = IdentityChangesSchema.safeParse(changes);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "change"}: ${issue.message}`);
  throw new BarryError("invalid", `Invalid identity change — ${issues.join("; ")}`);
}

/**
 * Check what a change names against what exists, and turn it into the
 * metadata `updateIdentity` writes (`undefined` deletes a key). Unknown traits,
 * newly added unregistered bags and missing named bounds are refused; an
 * unknown model or model provider is a warning, since sessions are where an
 * unroutable one is refused with the harness in hand.
 */
export async function prepareChanges(
  parsed: IdentityChanges,
  current: IdentityMetadata,
): Promise<{ metadata: Partial<IdentityMetadata> & Record<string, unknown>; warnings: Warning[] }> {
  const metadata: Record<string, unknown> = {};
  const warnings: Warning[] = [];
  for (const [key, value] of Object.entries(parsed)) metadata[key] = value === null ? undefined : value;

  for (const kind of ["trait", "bound"] as const) {
    const names = kind === "trait" ? parsed.traits : parsed.bounds;
    if (!names) continue;
    const base = baseIdentityConfig();
    const entries = kind === "trait" ? [...parseTraits(current.traits), ...(base?.traits ?? [])] : [...parseBounds(current.bounds), ...(base?.bounds ?? [])];
    const stored = kind === "trait" ? await Traits.list() : await bounds.list();
    const known = new Set([...stored.map(entry => entry.name!), ...entries.map(entry => entry.name)]);
    try {
      const installed = loadAdapters({ file: barryAdaptersPath() }).installed();
      resolveHarnessNames(names, known, { bags: installed.flatMap(record => record.bag ? [record.bag.manifest.name] : []) }, kind);
    } catch (error) { throw new BarryError("invalid", error instanceof Error ? error.message : String(error)); }
  }
  if (parsed.bags) {
    // Only newly added names must be registered: an identity carrying one
    // stale bag name stays editable, and the stale name becomes a warning.
    const added = parsed.bags.filter((name) => !(current.bags ?? []).includes(name));
    try {
      if (added.length > 0) await resolveAndSyncBags(added, { strict: true, skipTraitSync: true });
      const result = await resolveAndSyncBags(parsed.bags);
      metadata.bags = result.bags;
      warnings.push(...bagWarnings(result.warnings));
    } catch (error) {
      if (error instanceof UnregisteredBagError) throw new BarryError("invalid", `Unknown bags: ${error.bags.join(", ")}`, "`barry bag list` names the registered ones");
      throw error;
    }
  }
  if (parsed.adapters) {
    try { defaultHarness(parsed.adapters); } catch (error) { throw new BarryError("invalid", error instanceof Error ? error.message : String(error)); }
    const adapters: IdentityAdapters = {};
    for (const [key, settings] of Object.entries(parsed.adapters)) {
      const record = knownHarness(key);
      const id = record?.id ?? key;
      if (Object.hasOwn(adapters, id)) throw new BarryError("invalid", `Two adapter keys name the same harness: ${id}`);
      adapters[id] = settings;
      if (!record) warnings.push({ kind: "unknown-harness", message: `Unknown harness '${key}' — install it before starting a session` });
      if (settings.model && !isKnownModelFor(key, settings.model)) warnings.push({ kind: "unknown-model", message: `Unknown model id '${settings.model}' for ${key} — not in the curated catalog` });
      if (settings.mode && record?.modes && !record.modes[settings.mode]) warnings.push({ kind: "unknown-mode", message: `${key} does not declare mode '${settings.mode}'` });
    }
    metadata.adapters = adapters;
  }
  return { metadata: metadata, warnings };
}

/** Where a removed identity's managed directory goes: beside the identities folder, out of its scan. */
export function removedDirectory(name: string): string {
  return join(dirname(getIdentitiesDir()), "identities-removed", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
}

/** The next default after `removed` goes away: oldest first, matching first-create-wins. Undefined leaves the pointer alone. */
export function nextDefaultIdentity(removed: string, active: string | null, remainingOldestFirst: readonly string[]): string | null | undefined {
  if (active !== removed) return undefined;
  return remainingOldestFirst[0] ?? null;
}

const OWNER: Caller = Object.freeze({ kind: "owner" });

export const identityRecords = {
  /** The owner's identities, as records: what a command walks when it needs the rows and directories. */
  async list(): Promise<IdentityEntry[]> {
    return entries(await userOf(OWNER));
  },

  /** Retired settings in the identity's own file, for explicit doctor migration. */
  retired(name: string): RetiredIdentityKeys {
    const dir = findIdentityDirectoryByName(name);
    if (!dir) return {};
    const yaml = yamlParse(readFileSync(findIdentityYamlPath(dir)!, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(RETIRED_IDENTITY_KEYS.filter(key => Object.hasOwn(yaml, key)).map(key => [key, yaml[key]]));
  },

  inlineBound(name: string) {
    const dir = findIdentityDirectoryByName(name);
    if (!dir) return undefined;
    const yaml = yamlParse(readFileSync(findIdentityYamlPath(dir)!, "utf8")) as Record<string, unknown>;
    return (yaml.bound ?? yaml.scope) as import("@barry-rocks/sdk").Bound | undefined;
  },
  async nameInlineBound(name: string): Promise<string | undefined> {
    const dir = findIdentityDirectoryByName(name);
    const bound = identityRecords.inlineBound(name);
    if (!dir || !bound) return undefined;
    // Only the metadata's bounds are read here, but the record carries an
    // actor_id and the reader now requires one (POL-19), so name the owner.
    const owner = await userOf(OWNER);
    const record = loadIdentityFromDirectory(dir, { actorId: owner.id });
    if ([...parseBounds(record.metadata.bounds), ...(baseIdentityConfig()?.bounds ?? [])].some(entry => entry.name === name)) throw new Error(`Bound ${name} is already named by the identity chain or base identity`);
    const yaml = yamlParse(readFileSync(findIdentityYamlPath(dir)!, "utf8")) as Record<string, unknown>;
    const entry: BoundEntry = { name, optional: false, bound: { ...bound, description: `${name}'s own restrictions, moved from bound:` } };
    writeIdentityYaml(dir, { bounds: serializeEntries([...parseBounds(yaml.bounds), entry]), bound: undefined, scope: undefined });
    await syncIdentityToDb(dir, { actorId: owner.id });
    return name;
  },

  /** One of the owner's identities, as its record; refused when there is none. */
  async find(ref: IdentityReference): Promise<IdentityEntry> {
    const user = await userOf(OWNER);
    return entry(await located(refOf(ref), user), user);
  },

  /**
   * Which identity a session or command acts as: an explicit id or name, then
   * `BARRY_IDENTITY` (a per-identity command), then the repository's `.barry`,
   * then the owner's default.
   */
  async resolve(
    selection: { id?: number | null; name?: string | null; repoPath?: string | null },
    caller: Caller = OWNER,
  ): Promise<ResolvedSessionIdentity> {
    const user = await userOf(caller);
    let resolved: ResolvedSessionIdentity;
    try {
      resolved = await resolveSessionIdentity({
        actorId: user.id,
        explicitBarryId: selection.id ?? null,
        explicitBarryName: selection.name ?? null,
        repoPath: selection.repoPath ?? null,
        activeBarryName: activeName(user),
      });
    } catch (error) {
      throw new BarryError("not_found", error instanceof Error ? error.message : String(error));
    }
    if (caller.kind === "device" && !hasIdentityGrant(caller.principal, resolved.barry.id)) {
      throw new BarryError("forbidden", "This device was not granted that identity");
    }
    return resolved;
  },

  /** The cached row for a row id: what a session's `identity_id` names. */
  row: Identities.get,
  /**
   * The owner's identity row a stored reference names: a schedule or a one-off
   * keeps its identity as a name, this node's stable id for it, or a row id.
   * Reads only; an identity without a row is not found.
   */
  async byReference(reference: string): Promise<IdentityRecord | undefined> {
    const owner = await Users.getInstallationOwner();
    if (!owner) return undefined;
    const ownRow = async (id: number) => {
      const row = await Identities.get(id);
      return row?.actor_id === owner.id ? row : undefined;
    };
    const named = await locate({ name: reference }, owner.id);
    if (named) return ownRow(named.record.id);
    const id = storedId(reference);
    return id === null ? undefined : ownRow(id);
  },
  /** Who owns the identity with this row id, or null when there is none: the check before acting for a session. */
  async actorOf(id: number): Promise<number | null> {
    return (await Identities.get(id))?.actor_id ?? null;
  },
  /** An identity's effective configuration: defaults applied, absent lists empty. */
  config: resolveIdentityConfig,
  /** The row id a session should store for this identity, syncing a directory's row first; null when it has none. */
  rowId: resolveForeignKeyId,
  /** Record that the identity was used just now. */
  touch: Identities.touchLastUsed,
  /** The identity acting for a GitHub App installation. */
  byGitHubInstallation: Identities.findByGitHubInstallation,
  /** An identity's directory, by name or by its pinned or synthetic id. */
  directory(ref: IdentityRef): string | null {
    return "name" in ref ? findIdentityDirectoryByName(ref.name) : findIdentityDirectoryById(ref.id);
  },
  /** The base identity's directory: the repository root. */
  builtinDirectory: getBuiltinIdentityDir,
  /** Refresh a directory identity's row from its file now, rather than at the next session start. */
  sync: syncIdentityToDb,
  /** The fields where a row disagrees with its identity.yaml. */
  drift: findIdentityDrift,
  /** The identity a repository names in its `.barry`, and the repository's root. */
  repoDefault: readRepoIdentityDefault,
  gitRoot: findGitRoot,
  /** Why an identity was chosen, in the words a session prints at startup. */
  describeSource: describeIdentitySource,
  /** The id an identity's command binds to before it has a row: a hash of its name. */
  syntheticId: syntheticIdFromName,
  /**
   * Pin the row id an identity's command is bound to into its identity.yaml,
   * so the command keeps naming the same identity. The base identity's file is
   * shared by every machine and is never pinned.
   */
  pinBinding(directory: string, id: number): void {
    if (resolve(directory) !== getBuiltinIdentityDir()) writeIdentityYaml(directory, { id });
  },
};

export type { ResolvedSessionIdentity };
