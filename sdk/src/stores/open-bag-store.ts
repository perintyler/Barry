/**
 * One way to open a bag's SQLite store. Every process opens the file itself;
 * WAL makes that safe across processes, and the order of what is set on open
 * is decided here once:
 *
 * 1. `busy_timeout` before anything that can wait on a lock. Switching to WAL
 *    takes one, so a store set the other way round failed whenever another
 *    process held it at that moment.
 * 2. `journal_mode = WAL`, then `foreign_keys`, then `synchronous`.
 * 3. Migrations, inside `migrateStore`'s own transaction.
 *
 * A store scoped to an identity keeps one handle per identity, chosen by the
 * store context the caller runs in; any other store keeps one per process.
 * The bag supplies its driver (`connect`). All connections to the same file
 * in one process must use the same SQLite library; Barry runtime stores use
 * better-sqlite3, including short-lived registry and identity probes.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { currentStoreContext } from "./context.js";
import { migrateStore, type MigratableDatabase, type Migration } from "./migrate.js";
import { assertScratchStoreUnderTest } from "./scratch-guard.js";

/** The part of a SQLite handle a bag store needs. better-sqlite3 and node:sqlite both fit. */
export interface StoreHandle extends MigratableDatabase {
  close(): unknown;
}

export interface BagStoreOptions<D extends StoreHandle> {
  /** The store's file name, as migrations and errors name it: `events.db`. */
  file: string;
  migrations: readonly Migration[];
  /** Where the store is for the current store context; asked on every open. */
  path: () => string;
  /** Open the file with the bag's driver: `(path) => new Database(path)`. */
  connect: (path: string) => D;
  /** Keep a handle per identity when the store context names one. */
  identityScoped?: boolean;
  /** Refuse a path outside a scratch directory under test, naming this label. */
  scratchGuard?: string;
  /** On by default. */
  foreignKeys?: boolean;
  synchronous?: "FULL" | "NORMAL";
  /** Run on each newly opened handle before its migrations: adopting a store from before it had any. */
  adopt?: (db: D) => void;
  /** Run on each newly opened handle, after its migrations. */
  onOpen?: (db: D, path: string) => void;
}

export interface BagStore<D extends StoreHandle> {
  /** The handle for the current store context, opened on first use. */
  db(): D;
  /** The path the current store context's handle opens. */
  path(): string;
  /** Use this handle instead (a test); it is migrated, and the previous one closed. */
  replace(db: D): void;
  /** Close every handle; the next use opens again. */
  close(): void;
}

/** Open a SQLite file with the settings every bag store uses, before any migration. */
export function openStoreFile<D extends StoreHandle>(
  path: string,
  options: Pick<BagStoreOptions<D>, "connect" | "foreignKeys" | "synchronous">,
): D {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = options.connect(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    if (options.foreignKeys ?? true) db.exec("PRAGMA foreign_keys = ON");
    if (options.synchronous) db.exec(`PRAGMA synchronous = ${options.synchronous}`);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function openBagStore<D extends StoreHandle>(options: BagStoreOptions<D>): BagStore<D> {
  let shared: D | null = null;
  const byIdentity = new Map<string, D>();

  const open = (path: string): D => {
    if (options.scratchGuard) assertScratchStoreUnderTest(options.scratchGuard, path);
    const db = openStoreFile(path, options);
    try {
      options.adopt?.(db);
      migrateStore(db, options.migrations, options.file);
      options.onOpen?.(db, path);
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  };

  return {
    db() {
      if (options.identityScoped && currentStoreContext()?.identity) {
        const path = options.path();
        const cached = byIdentity.get(path);
        if (cached) return cached;
        const db = open(path);
        byIdentity.set(path, db);
        return db;
      }
      shared ??= open(options.path());
      return shared;
    },
    path: options.path,
    replace(db) {
      shared?.close();
      migrateStore(db, options.migrations, options.file);
      shared = db;
    },
    close() {
      for (const db of byIdentity.values()) db.close();
      byIdentity.clear();
      shared?.close();
      shared = null;
    },
  };
}
