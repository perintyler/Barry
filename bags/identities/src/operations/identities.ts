/**
 * The identities subject: this bag's answer to `Barry.identities()`,
 * `Barry.identity(ref)`, `Barry.traits()` and `Barry.bounds()`. Each call
 * carries its caller and decides what that caller may do: the owner anything,
 * a paired device only the identities it was granted, a session only its own
 * identity. Each write validates its input, writes `identity.yaml`, refreshes
 * the cached row and announces the change, whichever door it came through.
 */
import { mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  BarryError,
  type Caller,
  type Identities,
  type Identity,
  type IdentityReference,
  type IdentityUpdate,
  type Trait,
  type Updated,
  type Warning,
} from "@barry-rocks/sdk";
import { hasIdentityGrant, hasScope } from "@barry-rocks/sdk/internal/auth";
import { parseTraits, parseBounds, requiredNames, type IdentityChanges, type SecretBindings } from "@barry-rocks/sdk/internal/identities";

import { Identities as IdentityRows, type IdentityRecord } from "../store/identities.js";
import { Users, type UserRecord } from "../store/users.js";
import { bounds } from "./bounds.js";
import { type TraitInfo } from "../config/traits.js";
import {
  isReservedIdentityName,
  createIdentityDirectory,
  findIdentityDirectoryByName,
  isIdentityDirectory,
  loadIdentityFromDirectory,
  readIdentitiesRegistry,
  syncIdentityToDb,
  unregisterIdentityDirectory,
  updateIdentity,
  type IdentityYaml,
} from "../store/identity-files.js";
import { getBuiltinIdentityDir, getIdentitiesDir, getIdentityDir } from "../paths.js";
import { listSelectableTraits } from "../selectable-traits.js";
import { devices } from "../devices.js";
import { announceIdentity, refreshLiveSessions } from "./effects.js";
import { grantsFromStore, identityTraitsFromStore } from "../config/session-bound.js";
import {
  activeName,
  entries,
  entry,
  located,
  nextDefaultIdentity,
  parseChanges,
  prepareChanges,
  refOf,
  removedDirectory,
  userOf,
  type IdentityEntry,
} from "./identity-records.js";

const OWNER_ONLY = "Only the installation's owner may change identities";

function ownerOnly(caller: Caller, message = OWNER_ONLY): void {
  if (caller.kind !== "owner") throw new BarryError("forbidden", message);
}

/** Refuse a caller that may not read this identity: a device without the grant, a session of another identity. */
function mayRead(caller: Caller, record: IdentityRecord): void {
  if (caller.kind === "device") {
    if (!hasScope(caller.principal, "identities:read") || !hasIdentityGrant(caller.principal, record.id)) {
      throw new BarryError("forbidden", "This device may not read that identity");
    }
  }
  if (caller.kind === "session" && caller.identity !== record.name && caller.identity !== record.id) {
    throw new BarryError("forbidden", "A session may read only its own identity");
  }
}

/** Credential provenance only; values never leave the machine. */
function secretSources(secrets: SecretBindings): Record<string, string> {
  return Object.fromEntries(Object.entries(secrets).map(([name, binding]) => [name, binding.reference.in]));
}

/** An identity as `Barry` hands it out. */
export function identityOf({ record, isDefault, source, dir }: IdentityEntry): Identity {
  const meta = record.metadata;
  return {
    id: record.id,
    name: record.name,
    token: record.token,
    displayName: typeof meta.display_name === "string" ? meta.display_name : null,
    bags: Array.isArray(meta.bags) ? meta.bags : [],
    traits: requiredNames(parseTraits(meta.traits)),
    bounds: requiredNames(parseBounds(meta.bounds)),
    // Directory identities carry their deny rules inline instead of by id.
    bound: (meta.bound ?? meta.scope) ?? null,
    adapters: meta.adapters ?? {},
    envKeys: Object.keys(meta.secrets ?? {}),
    envSources: secretSources(meta.secrets ?? {}),
    vaultEmail: null,
    statusNotify: meta.status_notify ?? null,
    githubInstallationId: typeof meta.github?.installationId === "number" ? meta.github.installationId : null,
    isDefault,
    lastUsedAt: record.last_used_at,
    createdAt: record.created_at,
    source,
    directory: dir,
  };
}

function traitOf(trait: TraitInfo): Trait {
  return {
    name: trait.name,
    description: trait.description,
    access: trait.access,
    namespaces: trait.namespaces,
    ...(trait.skills.length > 0 ? { skills: trait.skills } : {}),
    ...(trait.tools.length > 0 ? { tools: trait.tools } : {}),
    ...(trait.instructions.length > 0 ? { instructions: trait.instructions } : {}),
    ...(Object.keys(trait.bound).length > 0 ? { bound: { ...trait.bound } } : {}),
    ...(trait.boundNames.length > 0 ? { boundNames: trait.boundNames } : {}),
    ...(trait.bag !== undefined ? { bag: trait.bag } : {}),
    ...(trait.nativeTools ? { nativeTools: trait.nativeTools } : {}),
    ...(trait.includes?.length ? { includes: trait.includes } : {}),
    ...(trait.harnessTraits && Object.keys(trait.harnessTraits).length > 0 ? { harnessTraits: trait.harnessTraits } : {}),
  };
}

/** An update in `identity.yaml`'s vocabulary: present keys change, `null` clears. */
const UPDATE_FIELDS: ReadonlySet<string> = new Set<keyof IdentityUpdate>([
  "displayName", "bags", "bagConfigs", "traits", "bounds", "adapters",
  "statusNotify", "githubInstallationId", "vault", "secrets", "aliases",
]);

export function changesOf(update: IdentityUpdate): IdentityChanges {
  // A misspelt field is refused, not dropped: a change that silently did nothing reads as one that worked.
  const unknown = Object.keys(update).filter((field) => !UPDATE_FIELDS.has(field));
  if (unknown.length > 0) throw new BarryError("invalid", `Unknown identity fields: ${unknown.join(", ")}`);
  const changes: Record<string, unknown> = {};
  const keys: Array<[keyof IdentityUpdate, string]> = [
    ["displayName", "display_name"], ["bags", "bags"], ["bagConfigs", "bag_configs"], ["traits", "traits"],
    ["bounds", "bounds"], ["adapters", "adapters"], ["statusNotify", "status_notify"],
    ["vault", "vault"], ["aliases", "aliases"],
  ];
  for (const [field, key] of keys) if (Object.hasOwn(update, field)) changes[key] = update[field];
  if (Object.hasOwn(update, "secrets")) {
    // identity.yaml binds each secret name to where its value lives.
    changes.secrets = update.secrets == null ? update.secrets
      : Object.fromEntries(Object.entries(update.secrets).map(([name, reference]) => [name, { reference }]));
  }
  if (Object.hasOwn(update, "githubInstallationId")) {
    changes.github = update.githubInstallationId == null ? null : { installationId: update.githubInstallationId };
  }
  return parseChanges(changes);
}

/** Write a checked change to an identity the user owns, and announce it. */
async function write(user: UserRecord, ref: IdentityReference, changes: IdentityChanges): Promise<Updated<Identity>> {
  const found = await located(refOf(ref), user);
  if (!found.dir) {
    throw new BarryError("conflict", `Identity "${found.record.name}" has no identity.yaml, and an identity without a directory cannot be changed`,
      `Remove it with barry identity delete ${found.record.name} and create it again`);
  }
  if (found.dir === getBuiltinIdentityDir()) {
    throw new BarryError("conflict", `"${found.record.name}" is the base identity Barry ships; change it in the repository's identity.yaml`);
  }
  const prepared = await prepareChanges(changes, found.record.metadata);
  await updateIdentity(found.record, prepared.metadata);
  const updated = loadIdentityFromDirectory(found.dir, { actorId: user.id });
  announceIdentity(updated.id, "updated");
  if (Object.hasOwn(changes, "bags") || Object.hasOwn(changes, "traits") || Object.hasOwn(changes, "bounds")) refreshLiveSessions(updated, user.id);
  return { ...identityOf(entry({ record: updated, dir: found.dir }, user)), warnings: prepared.warnings };
}

export const identities: Identities = {
  name: "identities",

  async list(caller) {
    if (caller.kind !== "owner") throw new BarryError("forbidden", "Only the installation's owner may list identities");
    return (await entries(await userOf(caller))).map(identityOf);
  },

  async get(ref, caller) {
    const user = await userOf(caller);
    const found = await located(refOf(ref), user);
    mayRead(caller, found.record);
    return identityOf(entry(found, user));
  },

  async create(input, caller) {
    ownerOnly(caller);
    const user = await userOf(caller);
    const { name: raw, directory, inherits, ...update } = input;
    const name = raw.trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name) || name.length > 100) {
      throw new BarryError("invalid", "An identity name is letters, digits, dashes and underscores, starting with a letter or digit");
    }
    if (isNumericIdentityName(name)) throw new BarryError("invalid", "An identity name cannot be digits only: the API reads /identities/<name> as a name before an id, so it would shadow the identity whose id it is");
    if (isReservedIdentityName(name)) throw new BarryError("invalid", `"${name}" is the base identity Barry ships`);
    const dir = directory ? resolve(directory) : getIdentityDir(name);
    if (await IdentityRows.getByName(user.id, name) || findIdentityDirectoryByName(name) || isIdentityDirectory(dir)) {
      throw new BarryError("conflict", `An identity named "${name}" already exists`);
    }
    const prepared = await prepareChanges(changesOf(update), {});
    // The directory first, with only what identifies it; then the configuration
    // through the same write `update` uses, so a key is spelled in the file the
    // way an edit would spell it and nothing inherited is copied into the child.
    const config: Partial<IdentityYaml> = inherits !== undefined ? { inherits } : {};
    createIdentityDirectory(name, config, { dir });
    const { identityId } = await syncIdentityToDb(dir, { actorId: user.id });
    if (Object.keys(prepared.metadata).length > 0) await updateIdentity({ id: identityId, name, actor_id: user.id }, prepared.metadata);
    const created = loadIdentityFromDirectory(dir, { actorId: user.id });
    announceIdentity(created.id, "created");
    return { ...identityOf(entry({ record: created, dir }, user)), warnings: prepared.warnings };
  },

  async update(ref, update, caller) {
    ownerOnly(caller);
    return write(await userOf(caller), ref, changesOf(update));
  },

  /**
   * Remove an identity: its row, and its directory's place in Barry. A
   * directory Barry created in its own folder is moved aside, not deleted; one
   * recorded elsewhere (a repository of yours) is unregistered and left as it
   * is. The default moves to the oldest remaining identity. Its sessions are
   * the sessions subject's: `Barry.identity(ref).remove()` removes them first.
   */
  async remove(ref, caller) {
    ownerOnly(caller);
    const user = await userOf(caller);
    const found = await located(refOf(ref), user);
    const name = found.record.name;
    if (found.dir && found.dir === getBuiltinIdentityDir()) {
      throw new BarryError("conflict", `"${found.record.name}" is the base identity Barry ships and cannot be removed`);
    }
    const row = await IdentityRows.getByName(user.id, name);
    if (row) await IdentityRows.delete(row.id);

    let directory: "moved" | "unregistered" | null = null;
    let movedTo: string | undefined;
    if (found.dir) {
      if (Object.hasOwn(readIdentitiesRegistry(), name)) {
        unregisterIdentityDirectory(name);
        directory = "unregistered";
      }
      if (resolve(dirname(found.dir)) === resolve(getIdentitiesDir())) {
        movedTo = removedDirectory(name);
        mkdirSync(dirname(movedTo), { recursive: true });
        renameSync(found.dir, movedTo);
        directory = "moved";
      }
    }

    const remaining = (await IdentityRows.list(user.id)).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((r) => r.name);
    const next = nextDefaultIdentity(name, activeName(user), remaining);
    if (next !== undefined) {
      const { defaultBarry: _previous, ...settings } = user.settings;
      await Users.updateSettings(user.id, next === null ? settings : { ...settings, defaultBarry: next });
    }
    announceIdentity(found.record.id, "deleted");
    return { name, sessionsDeleted: 0, directory, ...(movedTo ? { movedTo } : {}), nextDefault: next };
  },

  async makeDefault(ref, caller) {
    ownerOnly(caller);
    const user = await userOf(caller);
    const found = await located(refOf(ref), user);
    await Users.updateSettings(user.id, { ...user.settings, defaultBarry: found.record.name });
  },

  async traits(ref, caller) {
    const user = await userOf(caller);
    const found = await located(refOf(ref), user);
    mayRead(caller, found.record);
    return (await identityTraitsFromStore(found.record)).map(({ trait, optional, name }) => ({ ...traitOf(trait), name, optional }));
  },

  /**
   * Everything a session of this identity gets, given what the session selects
   * on top: its effective traits and bound, its namespaces, and the tools,
   * skills and instructions they grant. `null` asks for a session with no
   * identity (a schedule that names only traits). One answer for every launch
   * path, so none of them can leave the identity's own traits or the defaults out.
   */
  async grants(ref, selection, caller) {
    let identity: IdentityRecord | undefined;
    if (ref !== null) {
      const user = await userOf(caller);
      const found = await located(refOf(ref), user);
      if (caller.kind === "device" && !hasIdentityGrant(caller.principal, found.record.id)) {
        throw new BarryError("forbidden", "This device was not granted that identity");
      }
      mayRead(caller, found.record);
      identity = found.record;
    }
    try {
      return await grantsFromStore(identity, selection);
    } catch (error) {
      throw new BarryError("invalid", error instanceof Error ? error.message : String(error));
    }
  },

  /** The traits sessions can select: those a reachable bag still backs, and the hand-authored ones. */
  async allTraits(caller) {
    if (caller.kind === "device") throw new BarryError("forbidden", "A device may not list traits");
    return (await listSelectableTraits()).map(traitOf);
  },

  async bounds(caller) {
    if (caller.kind === "device") throw new BarryError("forbidden", "A device may not list bounds");
    return bounds.list();
  },

  async owner(caller) {
    ownerOnly(caller, "Only the installation's owner may read who owns it");
    const user = await userOf(caller);
    return { id: user.id, name: user.name, defaultIdentity: activeName(user) };
  },

  async devices(caller) {
    ownerOnly(caller, "Only the installation's owner may list paired devices");
    const user = await userOf(caller);
    return devices().list(user.id).filter((device) => device.revokedAt === null).map((device) => ({
      id: device.id,
      name: device.name,
      scopes: [...device.scopes],
      identityIds: [...device.identityIds],
      pairedAt: new Date(device.createdAt).toISOString(),
      lastSeenAt: device.lastUsedAt === null ? null : new Date(device.lastUsedAt).toISOString(),
    }));
  },

  async revokeDevice(id, caller) {
    ownerOnly(caller, "Only the installation's owner may revoke a device");
    const user = await userOf(caller);
    if (!devices().revoke(user.id, id)) throw new BarryError("not_found", `Device ${id} not found`);
  },
};

export type { Warning };

export function isNumericIdentityName(name: string): boolean { return /^[0-9]+$/.test(name); }
