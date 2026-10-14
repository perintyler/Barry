/**
 * The per-identity environment.
 *
 * A single shared process serves many identities: each request carries an
 * identity, the process works out which one the request concerns, and builds
 * that identity's environment for the call. `engine` has done this per
 * session init from the beginning; this is that logic with the MCP shape
 * peeled off, so a bag service can build an identity's environment per
 * request without importing an MCP server.
 *
 * Lives in its own module (exported as `@barry-rocks/sdk/internal/env`)
 * because it is the only part of this package that needs an identities
 * store. It does not import one — the store is injected, by whoever already
 * holds it, so this package names no bag.
 */

import { openVault } from "../vault/account.js";
import type { VaultSession } from "../vault/account.js";
import { readSecretBindings } from "./secret-bindings.js";
import { parseVaultName } from "../identities/secrets.js";
import type { SecretBindings } from "../identities/secrets.js";
import { EnvReadError } from "./types.js";
import type { EnvSourceName, Environment } from "./types.js";
export type { Environment, EnvSourceName };

/** Credential references and catalog configuration from a resolved identity. */
export interface IdentityRecord {
  secrets: SecretBindings;
  vault?: string;
  bags: string[];
  status_notify?: unknown;
}

export interface IdentityStore<Record_ = unknown> {
  get(identityId: number): Promise<Record_ | null | undefined>;
  resolveConfig(barry: Record_): IdentityRecord;
  touchLastUsed(identityId: number): Promise<unknown>;
}

/**
 * The installed store, with its record type sealed inside: a record `get`
 * returns only ever goes back to the same store's `resolveConfig`.
 */
interface InstalledIdentityStore {
  resolvedConfig(identityId: number): Promise<IdentityRecord | null>;
  touchLastUsed(identityId: number): Promise<unknown>;
}

let identityStore: InstalledIdentityStore | null = null;

/** Install the identities store. Called once, by a composition root. */
export function setIdentityStore<R>(store: IdentityStore<R>): void {
  invalidateIdentityEnvironment();
  identityStore = {
    resolvedConfig: async (identityId) => {
      const record = await store.get(identityId);
      return record ? store.resolveConfig(record) : null;
    },
    touchLastUsed: (identityId) => store.touchLastUsed(identityId),
  };
}

/**
 * The installed store. Throws rather than resolving to an empty environment:
 * an identity with nothing configured returns one legitimately, so falling
 * back would make "the store was never installed" look exactly like "this
 * identity has no variables".
 */
function requireIdentityStore(): InstalledIdentityStore {
  if (!identityStore) {
    throw new Error(
      "No identity store installed — cannot build an identity environment. The " +
        "composition root must call setIdentityStore() at boot, e.g. with the " +
        "identities bag's `identities.row`, `identities.config` and `identities.touch`.",
    );
  }
  return identityStore;
}

/** How the caller wants to hear about a partial failure. */
export interface EnvLogger {
  warn(event: string, fields: Record<string, unknown>): void;
  info?(event: string, fields: Record<string, unknown>): void;
}

export interface IdentityEnvironmentOptions {
  /** Resolve only the secrets needed by this invocation. */
  names?: readonly string[];
  log?: EnvLogger;
  /**
   * Mark the identity as used. On by default: building an identity's
   * environment is the identity being used. A caller polling on a timer can
   * turn it off so the timestamp keeps meaning "someone did something".
   */
  touch?: boolean;
  /**
   * Serve a cached environment when one was built within this many
   * milliseconds. 0 (the default) builds every time — what MCP wants, since
   * it builds once per session init.
   */
  cacheTtlMs?: number;
  /** A vault session already open for this identity, to reuse instead of opening one. */
  vault?: VaultSession;
}

interface CacheEntry {
  builtAt: number;
  /** The in-flight build, so concurrent callers share one vault login. */
  value: Promise<Environment>;
}

const cache = new Map<number, Map<string, CacheEntry>>();

/**
 * Drop a cached environment.
 *
 * Call after changing an identity's env or vault, so the next request builds
 * fresh rather than serving the old values until the TTL lapses. With no
 * argument, drops everything.
 *
 * THIS CACHE IS PER-PROCESS. A CLI command clearing it affects only the CLI
 * process that is about to exit; the engine and the sessions API keep their
 * own copies. The accepted policy is TTL, not notification: long-running
 * callers pass `cacheTtlMs`, and the engine passes 0 and rebuilds per session
 * init, so it is already current.
 *
 * After a write to a SHARED vault, every identity that opens it holds a stale
 * entry — so invalidate with no argument after a vault mutation. The cache
 * holds single digits of entries; rebuilding all of them costs one vault
 * login and is cheaper than reasoning about which ones overlap.
 */
export function invalidateIdentityEnvironment(identityId?: number): void {
  if (identityId === undefined) cache.clear();
  else cache.delete(identityId);
}

/**
 * Build the environment for an identity LOOKED UP BY ID.
 *
 * Throws when the identity's definitions do not read: a broken definition or
 * an unreachable vault is an answer a session needs ("refuse, and say what to
 * fix"), not an empty map to degrade on. The engine's bag path catches and
 * drops tools instead; nothing here pretends a broken identity is a healthy
 * empty one.
 */
export async function identityEnvironmentForId(
  identityId: number,
  options: IdentityEnvironmentOptions = {},
): Promise<Environment> {
  const { cacheTtlMs = 0 } = options;
  // Caller-owned vault sessions must not share another invocation's credential result.
  const cacheable = cacheTtlMs > 0 && options.vault === undefined;
  const selection = JSON.stringify({
    names: options.names === undefined ? null : [...new Set(options.names)].sort(),
    touch: options.touch ?? true,
  });
  if (cacheable) {
    const hit = cache.get(identityId)?.get(selection);
    if (hit && Date.now() - hit.builtAt < cacheTtlMs) return hit.value;
  }

  const pending = buildForId(identityId, options);

  if (cacheable) {
    const selections = cache.get(identityId) ?? new Map<string, CacheEntry>();
    const entry = { builtAt: Date.now(), value: pending };
    selections.set(selection, entry);
    cache.set(identityId, selections);
    // A late failure must not evict a newer successful build for this selection.
    pending.catch(() => {
      if (selections.get(selection) === entry) selections.delete(selection);
    });
  }

  return pending;
}

async function buildForId(identityId: number, options: IdentityEnvironmentOptions): Promise<Environment> {
  const { log, touch = true } = options;

  // OUTSIDE the try on purpose. A process that never installed a store is a
  // wiring bug, and swallowing it here would make that look exactly like an
  // identity with nothing configured.
  const Identities = requireIdentityStore();

  const resolved = await Identities.resolvedConfig(identityId);
  if (!resolved) {
    throw new Error(`identity ${identityId} not found`);
  }

  const env = await identityEnvironment(resolved, options);

  // Surface the identity's default notifier alongside its environment. It is
  // config, not a secret, but the env-injection path is the established way
  // identity data reaches a native tool handler.
  const statusNotify = resolved.status_notify
    ? JSON.stringify(resolved.status_notify)
    : await resolveBagDefaultNotifier(resolved.bags, log);
  if (statusNotify) {
    env.vars.BARRY_STATUS_NOTIFY = statusNotify;
    env.sources.BARRY_STATUS_NOTIFY = "value";
  }

  if (touch) {
    Identities.touchLastUsed(identityId).catch((err: unknown) => {
      log?.warn("identity.last_used_update_failed", { identityId, error: message(err) });
    });
  }

  log?.info?.("identity.environment_built", { identityId, vars: Object.keys(env.vars).length });
  return env;
}

/**
 * Build the environment for an identity RECORD the caller already resolved.
 *
 * Opens the record's vault (unless one was supplied), reads every declared
 * reference, and returns values + sources. Unreadable references fail the invocation.
 */
export async function identityEnvironment(
  identity: IdentityRecord,
  options: Omit<IdentityEnvironmentOptions, "touch"> = {},
): Promise<Environment> {
  const { log, vault, names } = options;
  if (identity.vault !== undefined) parseVaultName(identity.vault);
  if (identity.secrets === undefined) throw new Error("resolved identity must provide secret bindings");

  const bindings = names === undefined
    ? identity.secrets
    : Object.fromEntries(names.map((name) => {
      const binding = identity.secrets?.[name];
      if (!binding) throw new Error(`$${name}: secret is not declared by the selected identity`);
      return [name, binding];
    }));

  let session: VaultSession | undefined = vault;
  const needsVault = Object.values(bindings).some((binding) => binding.reference.in === "vault");
  if (!session && identity.vault && needsVault) {
    try {
      session = await openVault(identity.vault);
    } catch {
      const name = Object.keys(bindings).find(name => bindings[name].reference.in === "vault") ?? "VAULT";
      throw new EnvReadError(name, "could not open the declared vault");
    }
  }

  try {
    const env = await readSecretBindings(bindings, { vault: session });

    log?.info?.("identity.environment_built", { vars: Object.keys(env.vars).length });
    return env;
  } finally {
    // The resolver owns sessions it opens; injected sessions remain caller-owned.
    if (session && session !== vault) await session.close();
  }
}

/**
 * Find a default notifier among the identity's enabled bags.
 *
 * A bag can say "if you have not configured a notifier, I can carry one" —
 * see `default_notifier` on the manifest. Only consulted when the identity
 * has made no choice of its own, so this never overrides a user's setting.
 *
 * Bags are checked in the order the identity enables them and the first
 * declared default wins, so two bags offering one resolve the same way on
 * every call rather than depending on registry iteration order.
 *
 * Returns the JSON string that `BARRY_STATUS_NOTIFY` carries, or undefined.
 */
async function resolveBagDefaultNotifier(
  bagNames: string[],
  log?: EnvLogger,
): Promise<string | undefined> {
  if (bagNames.length === 0) return undefined;

  try {
    // Imported lazily: building an environment must not require the bag
    // registry, which reads the filesystem and is absent in some callers.
    //
    // Deliberately does NOT install the remote-bag discoverer. The hosts
    // that can reach a remote bag install it at startup; a call here is
    // redundant, and it would drag an MCP client onto the env path this
    // comment exists to keep light.
    const { loadBag, expandCompositionFromSnapshot } = await import("../bags/loader.js");

    // A parent composing e.g. `slack` should inherit its notifier, so search
    // the composed set rather than the explicitly packed names alone. Roots
    // are still emitted first, preserving "first declared default wins".
    const composed = await expandCompositionFromSnapshot(bagNames);

    for (const name of composed) {
      // loadBag is sync for local bags and async for remote ones.
      const bag = await loadBag(name);
      const notifier = bag?.manifest?.default_notifier;
      if (!notifier) continue;
      log?.info?.("identity.notifier_from_bag", { bag: name, tool: notifier.tool });
      return JSON.stringify(notifier);
    }
  } catch (err) {
    // A notifier is a convenience: a bag that will not load should not take
    // the whole environment build down with it.
    log?.warn("identity.bag_notifier_failed", { error: message(err) });
  }
  return undefined;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { identityEnvironmentForId as resolveIdentityCredentials };
