import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { barryAppSupportDir, barryStoresDir } from "@barry-rocks/sdk/services";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { backupManagedStores, MANAGED_STORES_DIR, UNMANAGED_DATA_DIR, UNMANAGED_STORES_DIR } from "./db-stores.js";

/** Where each backed-up store lives in the instance the backup was taken from. */
interface StorePaths {
  sessions: string;
  config: string;
  identities: string;
  actions: string;
  events: string;
  fileTracker: string;
}

/**
 * The restore runbook that ships inside every backup directory.
 *
 * Deliberately concrete: a restore happens under pressure, by whoever is
 * around, possibly from an R2 copy on a machine without this repo. Naming the
 * wrong-but-obvious command and what its failure looks like is the difference
 * between a two-minute restore and an hour spent suspecting a corrupt dump.
 * The paths are the ones this backup read from, so the guide cannot name a
 * layout the instance no longer has.
 */
function restoreInstructions(paths: StorePaths): string {
  return `# Restoring this backup

Every store here is SQLite. Stop the instance's services before copying any of
them back (\`barry service stop <service>\`, or stop \`barry up\`), and remove
the -wal/-shm files beside each store you replace.

## sessions.db — THE SESSION HISTORY

This is where sessions, messages and provider_sessions live. Every process
reads and writes this file directly, so this file IS the history.

Restore by copying it into place with the services stopped, as above:

    cp sessions.db "${paths.sessions}"
    rm -f "${paths.sessions}-wal" "${paths.sessions}-shm"

Stale -wal/-shm files beside a replaced database are a corruption risk, which
is why they are removed rather than left. This file is written with SQLite's
online backup API, so it is consistent even though it was copied from a live
database -- do not "fix" it by dumping SQL instead.

Verify before trusting it:

    sqlite3 sessions.db "pragma integrity_check;"       # expect: ok
    sqlite3 sessions.db "select count(*) from sessions;"

The service refuses to start when the store recorded at its path is missing,
so a restore that put the file somewhere else fails loudly rather than serving
an empty history.

## Other files

- \`config.db\` — installed bags and service port assignments. Restore to
  \`${paths.config}\`.
- \`identities.db\` — identities, actors, traits and bounds. Restore to
  \`${paths.identities}\`. Sessions carry an \`identity_id\`, so a
  sessions.db restored without its matching identities.db leaves every session
  pointing at an identity that is not there — and every reader of that column
  degrades SILENTLY (lost traits, lost bags, lost credentials).
- \`actions.db\` — action runs. Restore to \`${paths.actions}\`.
- \`events.db\` — the events log. Restore to \`${paths.events}\`.
- \`file-tracker.db\` — file tracking. Restore to \`${paths.fileTracker}\`.
- \`vault.db.age\` — vault snapshot, age-encrypted. Absent if the line in the
  backup output said SKIPPED; decrypt with the key at
  \`vault-backup-key.txt\` in the instance's application support directory.
`;
}

/**
 * The restore runbook for an install on the store-generation layout.
 *
 * Every store sits in one active generation, partitioned per identity, so a
 * per-file copy is the wrong tool: `barry db restore` rebuilds a new
 * generation from the verified snapshots and switches to it in one step,
 * leaving the previous generation on disk.
 */
function managedRestoreInstructions(storesRoot: string, generation: string): string {
  return `# Restoring this backup

This backup holds every store of the installation it was taken from:

- \`${MANAGED_STORES_DIR}/<id>/\` — every store a bag declares: the node stores
  (config, identities, the sessions catalog, schedules, workflows, peers.db,
  ...) and every identity's stores (sessions, memory, artifacts with their
  blobs, ...). \`manifest.json\` names each \`N.db\` with its bag, store,
  identity and checksum.
- \`${UNMANAGED_STORES_DIR}/\` — SQLite files no installed bag declares, copied
  as-is at their path inside the generation.
- \`${UNMANAGED_DATA_DIR}/<bag>/<file>\` — stores bags keep in their own data
  directory, \`${join(barryAppSupportDir(), "data")}/<bag>/\`, outside the
  store generation, copied consistently. \`barry db restore\` does not put
  these back; see below.
- \`config.db\`, \`sessions.db\`, \`identities.db\`, \`actions.db\`, \`events.db\`,
  \`file-tracker.db\` — top-level copies of node stores, kept for tools that
  read them. \`sessions.db\` here is the sessions CATALOG; each identity's
  session history is under \`${MANAGED_STORES_DIR}/\`. Restore from there.
- \`vault.db.age\` — the vault, age-encrypted (absent if the backup output said
  SKIPPED); decrypt with \`vault-backup-key.txt\` in the instance's application
  support directory.

It was taken from the generation at:

    ${generation}

## Restore with Barry

Run:

    barry db restore "<this directory>"

This snapshots the current stores into the managed backups folder and
verifies every snapshot (checksum, schema version, integrity and foreign keys)
while the services still run. Then it stops the running user services, builds
a NEW store generation from the current one with the backup laid over it, and
switches \`${storesRoot}/active.json\` to it. The previous generation is kept
on disk untouched. The same services start again, on the previous generation
if the switch fails; system services such as the vault keep running.

Restoring onto a different installation (a new machine) replaces its
installation id with this backup's — pass \`--replace-installation\`. Order
matters and the command handles it: peers.db (the installation id and the
identity folder mapping) comes back together with the identity stores it
names, and the workflows database last.

Workflow runs that were running at backup time come back **blocked**
(\`RecoveryPaused\`). Check what each run had already done outside Barry,
then \`barry workflows resume <run>\`. The code a run was pinned to is not in
this backup: it comes from the installed bags, so reinstall them first.

## Stores outside the generation

\`${UNMANAGED_DATA_DIR}/\` holds the stores bags keep in their own data
directory, outside the store generation. \`barry db restore\` leaves them
alone: every restore is a generation switch that \`barry db rollback\` can
undo, and writing these files in place could not be undone that way. When it
finishes, it prints each one and where it belongs now:
\`${join(barryAppSupportDir(), "data")}/<bag>/<file>\`, or the path inside the
restored generation once its bag keeps the store there.

To put one back, stop every process that has it open first:

    lsof "<path>"                      # every process that has it open
    barry service stop <service>       # each of them; mcp.server too when the bag's tools open it
    for s in "" -wal -shm; do [ -e "<path>$s" ] && mv "<path>$s" "<path>$s.before-restore"; done
    cp "${UNMANAGED_DATA_DIR}/<bag>/<file>" "<path>"
    barry service start <service>

Move the \`-wal\` and \`-shm\` files too: SQLite would replay a left-behind
WAL into the copied store. Writes made since this backup are lost from the
store; the \`.before-restore\` files keep them.

## Undo a restore

Run \`barry db rollback\` to activate a copy of the generation that was active
before this restore. Writes since the restore stop being used, but remain in
its generation and in the pre-rollback snapshot. Services use the installed
code; install matching code first after a migration. Running rollback again
undoes it, or restore the snapshot with \`barry db restore <snapshot>\`.

Barry keeps the active generation and the one before it, and deletes older ones
after each restore, rollback or recovery. If a restore is interrupted, run
\`barry db recover\`.

## Without Barry

Every store in this backup is a plain SQLite file, and \`manifest.json\` names
which file is which store. Open, inspect or export any of them with
\`sqlite3\`; nothing here needs Barry installed. To put them back into
service, install any Barry CLI and run \`barry db restore\` as above, into a
fresh \`BARRY_HOME\` if this machine's install is broken.

Verify any file before trusting it:

    sqlite3 N.db "pragma integrity_check;"       # expect: ok
`;
}

/**
 * Fail a backup whose SQLite copy is not readable end to end.
 *
 * `integrity_check` walks every page rather than reading a header, which is
 * what makes it catch damage that row counts and live queries do not.
 */
function assertSqliteBackupIntact(path: string, label: string): void {
  const probe = spawnSync("sqlite3", [path, "pragma integrity_check;"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // An absent sqlite3 must not read as a passing check -- that is the failure
  // mode this whole function exists to avoid, one level up.
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `${label} backup could not be verified (sqlite3 exited ${probe.status ?? "abnormally"}): `
        + `${(probe.stderr || probe.error?.message || "").trim()}`,
    );
  }
  const result = probe.stdout.trim();
  if (result !== "ok") {
    throw new Error(`${label} backup failed integrity_check: ${result.split("\n")[0]}`);
  }
  // SQLite removes its sidecars when the last connection closes. Never unlink
  // them here: verification must not invalidate another connection's WAL.
}

/**
 * Why this backup leaves the vault out, or null to include it.
 *
 * The vault is the machine's, not an instance's: one daemon at a fixed
 * socket, reached with the shell's BARRY_VAULT_* credentials. Backing up a
 * contributor or test instance (BARRY_HOME) copied the real vault's secrets
 * into that instance's scratch directory.
 */
export function vaultSkipReason(env: NodeJS.ProcessEnv, options: { vault?: boolean }): string | null {
  if (env.BARRY_HOME && !options.vault) {
    return "this is the instance BARRY_HOME names, and the vault is the machine's (pass --vault to include it)";
  }
  return null;
}

/** Where each fixed store lives in this instance. */
async function fixedStorePaths(): Promise<StorePaths> {
  const configDb = await import("../services/configuration/database.js");
  const sessionsDb = await import("@barry-rocks/sessions-bag/store/sessions-db");
  const actionsBag = await import("@barry-rocks/actions-bag/db");
  const eventsBag = await import("@barry-rocks/events-bag/db");
  const { store: identitiesStore } = await import("@barry-rocks/identities-bag");
  const fileTracker = await import("@barry-rocks/tracker-bag");
  return {
    sessions: sessionsDb.sessionsDbPath(),
    config: configDb.configDbPath(),
    identities: identitiesStore.path(),
    actions: actionsBag.getDbPath(),
    events: eventsBag.getDbPath(),
    fileTracker: fileTracker.getDbPath(),
  };
}

/**
 * The fixed set of top-level store copies every backup has carried: config,
 * sessions, identities, actions, events and the file tracker. Returns the
 * names written. On the store-generation layout these are node stores (the
 * sessions file is the catalog); the identity stores are under stores/.
 */
async function backupFixedStores(backupRoot: string): Promise<string[]> {
  const configDb = await import("../services/configuration/database.js");
  const sessionsDb = await import("@barry-rocks/sessions-bag/store/sessions-db");
  const actionsBag = await import("@barry-rocks/actions-bag/db");
  const eventsBag = await import("@barry-rocks/events-bag/db");
  const { store: identitiesStore } = await import("@barry-rocks/identities-bag");
  const fileTracker = await import("@barry-rocks/tracker-bag");

  // Installed bags and service port assignments. Left out, a restore would
  // lose every one of them.
  try {
    await configDb.backupConfigDb(join(backupRoot, "config.db"));
  } finally {
    configDb.closeConfigDb();
  }

  // The session history. Sessions, messages and provider_sessions are SERVED
  // from the sessions bag's store, and nothing else holds a copy, so a backup
  // without it restores a Barry with no history.
  const sessionsBackupPath = join(backupRoot, "sessions.db");
  try {
    await sessionsDb.backupSessionsDb(sessionsBackupPath);
  } finally {
    sessionsDb.closeSessionsDb();
  }
  // Verify the copy, because nothing downstream will.
  //
  // Measured on a deliberately corrupted backup: 200KB of zeroes written into
  // the middle of the file still let `select count(*) from sessions` return
  // the right 1014, and a service reading it answered session stats and
  // message searches with plausible rows.
  // SQLite serves whatever pages still parse. So a row count -- the obvious
  // check, and the one the plan asked for -- passes on a corrupt backup, and
  // the service cannot tell you either. `pragma integrity_check` caught it.
  //
  // Failing the whole command is deliberate: a backup that cannot be verified
  // is not a backup, and the caller needs to know now rather than during a
  // restore.
  assertSqliteBackupIntact(sessionsBackupPath, "sessions.db");

  // identities.db, actions.db and events.db.
  //
  // A backup that captures the sessions but not the identity that owns them,
  // or the action runs that reference them, restores a system that is subtly
  // wrong rather than obviously broken.
  //
  // Opened read-only through better-sqlite3's online `.backup()`, the same
  // WAL-safe API `backupSessionsDb` uses. Do not "fix" this to a file copy: a
  // plain cp of a live SQLite database can catch it mid-checkpoint.
  const { default: BetterSqlite3 } = await import("better-sqlite3");

  const extraStores: Array<{ name: string; path: string }> = [
    { name: "identities.db", path: identitiesStore.path() },
    { name: "actions.db", path: actionsBag.getDbPath() },
    { name: "events.db", path: eventsBag.getDbPath() },
  ];

  const capturedStores: string[] = [];
  for (const store of extraStores) {
    // A store that does not exist yet is not a failure: a machine that has
    // never run an action has no actions.db, and refusing to back up the rest
    // over that would be worse than the gap this closes.
    if (!existsSync(store.path)) continue;
    const dest = join(backupRoot, store.name);
    const source = new BetterSqlite3(store.path, { readonly: true });
    try {
      await source.backup(dest);
    } finally {
      source.close();
    }
    assertSqliteBackupIntact(dest, store.name);
    capturedStores.push(store.name);
  }

  try {
    await fileTracker.backupDb(join(backupRoot, "file-tracker.db"));
  } finally {
    fileTracker.closeDb();
  }

  return ["config.db", "sessions.db", ...capturedStores, "file-tracker.db"];
}

export async function dbBackupCommand(destination?: string, options: { vault?: boolean } = {}): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = destination
    ? resolve(destination)
    : join(barryAppSupportDir(), "backups", `database-${timestamp}`);
  mkdirSync(backupRoot, { recursive: true });

  // An install on the store-generation layout keeps every store -- every
  // identity's sessions, memory and artifacts, peers.db, the workflows
  // database -- in one active generation. The fixed list below predates that
  // layout and silently skipped most of it.
  if (existsSync(join(barryStoresDir(), "active.json"))) {
    writeFileSync(join(backupRoot, "RESTORE.md"), managedRestoreInstructions(barryStoresDir(), activeStoreRoot()));
    const lines = await backupManagedStores(backupRoot);
    // The fixed top-level copies stay too: the nightly job's freshness check
    // and older restore notes read them, and they are small node stores.
    const topLevel = await backupFixedStores(backupRoot);
    const vaultLine = await backupVaultLine(backupRoot, options);
    console.log(`Database backup created: ${backupRoot}`);
    for (const line of lines) console.log(line);
    for (const name of topLevel) console.log(`  ${name} (top-level copy of a node store)`);
    console.log(vaultLine);
    return;
  }

  // Record how to restore this, next to the thing being restored.
  //
  // Written per-backup rather than into docs/ so it survives travelling to R2
  // and back on a machine that may not have this checkout -- a restore happens
  // under pressure, by whoever is around, possibly without the repo.
  writeFileSync(join(backupRoot, "RESTORE.md"), restoreInstructions(await fixedStorePaths()));
  const written = await backupFixedStores(backupRoot);
  const vaultLine = await backupVaultLine(backupRoot, options);

  // Every file this command wrote gets a line. config.db was backed up but
  // never printed, so a reader checking the output concluded bags, traits and
  // bounds were unprotected -- and the fix for an imagined gap is to go
  // looking for a second backup mechanism that does not exist.
  console.log(`Database backup created: ${backupRoot}`);
  for (const name of written) console.log(`  ${name}`);
  console.log(vaultLine);
}

/** Back up the vault beside the stores; the line to print, SKIPPED with a reason when it is left out. */
async function backupVaultLine(backupRoot: string, options: { vault?: boolean }): Promise<string> {
  const { backupVault, isVaultRunning, vaultDbPath, VaultBackupError } = await import("./vault-backup.js");

  let vaultLine = "";
  const skipVault = vaultSkipReason(process.env, options);
  if (skipVault) {
    vaultLine = `  vault.db SKIPPED — ${skipVault}`;
  } else {
    try {
      // isVaultRunning() THROWS on a present-but-unreadable vault (that is its
      // job — an unreadable store must not read as an absent one). It MUST stay
      // inside this try, not outside it: by here every SQLite store above is
      // already backed up and verified, so letting it escape would abort the run
      // after the expensive, valuable work had succeeded. That is exactly what
      // the catch below exists to prevent, and for three nights it did the
      // opposite — `barry db backup` exited non-zero and the job alerted "Backup
      // FAILED" while a complete backup sat on disk, unmentioned and untrusted.
      // Do not hoist this call out; the bug it guards against is a fixed one.
      if (isVaultRunning()) {
        const vault = await backupVault(backupRoot);
        chmodSync(vault.path, 0o600);
        const name = vault.path.split("/").pop();
        vaultLine = `  ${name} (${vault.items} items, ${vault.accounts} accounts${vault.encrypted ? ", age-encrypted" : ""})`;
      } else {
        vaultLine = `  vault.db SKIPPED — no vault database at ${vaultDbPath()}`;
      }
    } catch (error) {
      // The vault is a separate store; losing it should not discard a good set of
      // database backups. Surface loudly instead of failing the whole backup.
      const message = error instanceof VaultBackupError ? error.message : String(error);
      vaultLine = `  vault.db SKIPPED — ${message}`;
    }
  }
  return vaultLine;
}
