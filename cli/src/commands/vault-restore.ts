import { randomUUID } from "node:crypto";
import { runVaultMaintenance } from "./vault-restore-maintenance.js";
import { vaultDaemon, legacyLabel } from "../services/system.js";
import { isBarryError } from "@barry-rocks/sdk";
import { parseVaultName } from "@barry-rocks/sdk/internal/identities";
import type { IdentityEntry } from "@barry-rocks/identities-bag";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  realpathSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

import { KeychainProvider } from "@barry-rocks/sdk/internal/env";
import { vaultAccountFor, vaultEmail, deriveKeys, decryptSymmetricKey, decrypt as vaultDecrypt } from "@barry-rocks/sdk/internal/vault";


import { vaultDbPath, vaultBackupSecret } from "./vault-backup.js";
import { daemonServicePid, isDaemonServiceRunning, stopDaemonService, startDaemonService } from "./vault-daemon.js";
import { barryAppSupportDir } from "@barry-rocks/sdk/services";

export class VaultRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultRestoreError";
  }
}

// Installs that have not completed system setup still run the legacy label.
const DAEMON_LABEL = legacyLabel("vault.api");
const DAEMON_PLIST_PATH = `/Library/LaunchDaemons/${DAEMON_LABEL}.plist`;

const AGE_MAGIC = "age-encryption.org/v1";
const MAX_SNAPSHOT_AGE_DAYS = 30;

interface VaultBackupManifest {
  timestamp: string;
  accounts: number;
  items: number;
  encrypted: boolean;
  tables: string[];
}

/** Reads the manifest beside a snapshot, if one exists. Older backups predate it. */
function readManifest(snapshotPath: string): VaultBackupManifest | null {
  const dir = snapshotPath.replace(/\/[^/]+$/, "");
  const manifestPath = join(dir, "vault.db.meta.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as VaultBackupManifest;
  } catch {
    return null; // Unreadable manifest degrades to "no manifest", not a hard failure.
  }
}

/**
 * Whether a file is age-encrypted. Checks the MAGIC HEADER, not the `.age`
 * extension: a mis-named file must fail loudly at decrypt rather than reach
 * SQLite as a "corrupt database" three steps later with no clue why.
 */
function isAgeEncrypted(path: string): boolean {
  const fd = readFileSync(path, { encoding: "utf-8", flag: "r" }).slice(0, AGE_MAGIC.length);
  return fd === AGE_MAGIC;
}

/** Decrypts an age-encrypted snapshot to a staging path. Never runs as root. */
function ageDecrypt(source: string, destPath: string, keyPath: string): void {
  if (!existsSync(keyPath)) {
    throw new VaultRestoreError(
      `Age private key not found at ${keyPath}, so ${source} cannot be decrypted. The key is meant to be kept off this machine: pass --age-key-path <key file> with your offline copy, or put it at ${keyPath} for this restore.`,
    );
  }
  const res = spawnSync("age", ["-d", "-i", keyPath, "-o", destPath, source], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    throw new VaultRestoreError(
      `age decryption failed: ${(res.stderr || "age exited unsuccessfully").trim()}`,
    );
  }
  if (!existsSync(destPath) || statSync(destPath).size === 0) {
    throw new VaultRestoreError("age decrypted to an empty file");
  }
}

interface SnapshotInfo {
  accounts: number;
  items: number;
  tables: string[];
}

/**
 * `PRAGMA integrity_check` and matching row counts prove the FILE survived.
 * They say nothing about whether the master password you hold still opens
 * it — bags/vault/README.md documents this exact failure mode: a backup can
 * pass every structural check and still be undecryptable, which is
 * indistinguishable from total data loss until someone tries to actually use
 * it. "Verify a backup by decrypting it, not by counting rows."
 */
function verifySnapshot(path: string): SnapshotInfo {
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new VaultRestoreError(`Cannot open snapshot as SQLite: ${(err as Error).message}`);
  }
  try {
    const ok = (db.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]?.integrity_check;
    if (ok !== "ok") throw new VaultRestoreError(`Snapshot failed integrity_check: ${ok}`);

    const accounts = (db.prepare("select count(*) c from accounts").get() as { c: number }).c;
    const items = (db.prepare("select count(*) c from items").get() as { c: number }).c;
    const tables = (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as Array<{ name: string }>)
      .map((r) => r.name);

    if (accounts === 0) throw new VaultRestoreError("Snapshot has zero accounts — refusing to restore an empty vault");
    return { accounts, items, tables };
  } finally {
    db.close();
  }
}

/**
 * The real check. Reads the target identity's own vault credentials from
 * Keychain — the same ones `provisionVaultAccount` wrote and
 * `openVault` reads — derives the item keys the same way the client
 * library does, and decrypts one real item. A snapshot that fails this is
 * useless regardless of what integrity_check said.
 */
async function verifyDecrypts(snapshotPath: string, identityName: string, metadata: unknown): Promise<void> {
  const ref = (metadata as { vault?: unknown } | null)?.vault;
  if (!ref) {
    throw new VaultRestoreError(`Identity "${identityName}" has no vault configured — cannot verify decryption`);
  }
  const vaultConfig = vaultAccountFor(parseVaultName(ref));

  const kc = new KeychainProvider({ service: vaultConfig.credentials.clientId.service });
  const masterPassword = await kc.get("", vaultConfig.credentials.masterPassword.account);
  if (!masterPassword) {
    throw new VaultRestoreError(
      `Master password not found in Keychain (account: ${vaultConfig.credentials.masterPassword.account}). ` +
      `Per bags/vault/README.md, a backup is useless without it — there is no reset path.`,
    );
  }

  // A named vault carries no email of its own (vaultAccountFor gives it ""), so
  // reading `vaultConfig.email` here looked up the empty string and reported
  // "No account for  in this snapshot" for every named-vault identity — and
  // would have salted deriveKeys with "" even if it had matched. The same
  // Keychain this function already reads supplies the email.
  let email: string;
  try {
    email = await vaultEmail(vaultConfig, (service, account) =>
      new KeychainProvider({ service }).get("", account));
  } catch (err) {
    throw new VaultRestoreError(err instanceof Error ? err.message : String(err));
  }

  const db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const account = db
      .prepare("select id, kdf_salt, encrypted_key from accounts where email = ?")
      .get(email.toLowerCase()) as { id: string; kdf_salt: string | null; encrypted_key: string } | undefined;
    if (!account) {
      throw new VaultRestoreError(
        `No account for ${email} in this snapshot. ` +
        `README.md warns picking the wrong account looks like a corrupt backup, not a wrong password — ` +
        `this is that check, done for you against the identity you named.`,
      );
    }

    const item = db
      .prepare("select password from items where account_id = ? and password is not null limit 1")
      .get(account.id) as { password: string } | undefined;
    if (!item) {
      // Zero items is not itself an error — a freshly provisioned account can
      // be legitimately empty — but it does mean this check cannot run.
      return;
    }

    // Exactly VaultClient.loginWithApiKey's sequence: deriveKeys already
    // returns the MASTER-derived encKey/macKey, which unwrap the account's
    // symmetric key into the ITEM-level encKey/macKey that actually decrypt
    // `items.password`. No manual HKDF needed — deriveKeys does it.
    const { encKey: masterEncKey, macKey: masterMacKey } = deriveKeys(masterPassword, email, account.kdf_salt);
    const { encKey, macKey } = decryptSymmetricKey(account.encrypted_key, masterEncKey, masterMacKey);

    try {
      vaultDecrypt(item.password, encKey, macKey);
    } catch (err) {
      throw new VaultRestoreError(
        `MAC verification failed decrypting a real item — this is very likely the WRONG MASTER PASSWORD ` +
        `for this snapshot, not a corrupt file (see bags/vault/README.md: "picking the wrong one looks ` +
        `like a corrupt backup"). Original error: ${(err as Error).message}`,
      );
    }
  } finally {
    db.close();
  }
}

interface StalenessReport {
  timestamp: string | null;
  ageDays: number | null;
  refuse: boolean;
}

/**
 * Age is always reported, never conditionally — a threshold-gated warning is
 * the exact mechanism that let the vault go unbacked for 8 nights without
 * anyone noticing. Refusal past MAX_SNAPSHOT_AGE_DAYS is the one place a
 * threshold earns its keep: as something the operator must explicitly
 * override, not a line they can scroll past.
 */
function checkStaleness(manifest: VaultBackupManifest | null, snapshotMtimeMs: number): StalenessReport {
  const timestamp = manifest?.timestamp ?? null;
  const whenMs = manifest ? new Date(manifest.timestamp).getTime() : snapshotMtimeMs;
  const ageDays = (Date.now() - whenMs) / 86_400_000;
  return {
    timestamp,
    ageDays,
    refuse: ageDays > MAX_SNAPSHOT_AGE_DAYS,
  };
}

export interface VaultRestoreOptions {
  name?: string;
  dryRun?: boolean;
  force?: boolean;
  acceptStale?: boolean;
  ageKeyPath?: string;
}

/**
 * Restore a vault snapshot onto this machine.
 *
 * The sequence below is load-bearing — each step exists to prevent a
 * SPECIFIC corruption, not out of general caution:
 *
 *  1. Identify by magic header, not filename — a mis-named file must fail at
 *     decrypt, not reach SQLite as a mystery "corrupt database".
 *  2. Decrypt as the invoking user, never root — the key is the user's.
 *  3. Verify structurally (integrity_check, counts) AND by decryption — see
 *     verifySnapshot / verifyDecrypts. Structural checks alone are exactly
 *     what README.md warns can pass on an unusable backup.
 *  4. Report staleness unconditionally, refuse past the threshold.
 *  5. Stage a standalone snapshot and fence every cooperating vault opener.
 *  6. Stop the daemon, verify PID exit and no remaining database handles.
 *  7. Preserve main database AND sidecars; verify a separate recovery clone.
 *  8. Install at 0640, rolling back the complete old set on failure.
 *  9. Start and prove liveness against an endpoint that actually opens the
 *     database — /health never touches it, so it cannot prove the restored
 *     file is readable.
 */
export async function vaultRestoreCommand(
  sourcePath: string,
  options: VaultRestoreOptions = {},
): Promise<void> {
  const staging = mkdtempSync(join(tmpdir(), "vault-restore-"));
  try {
    await runRestore(sourcePath, options, staging);
  } catch (error: unknown) {
    // Every verify/install step above throws VaultRestoreError (or lets a
    // library error like better-sqlite3's SqliteError propagate) rather than
    // handling its own console.error — this is the one place that happens,
    // matching every other command in this file. Centralizing it here also
    // means a step added later cannot forget to catch its own errors.
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function runRestore(
  sourcePath: string,
  options: VaultRestoreOptions,
  staging: string,
): Promise<void> {
  const { identityRecords } = await import("@barry-rocks/identities-bag");
  const { getCurrentUser, getActiveIdentity } = await import("../lib/current-user.js");

  if (!existsSync(sourcePath)) {
    console.error(`Error: ${sourcePath} does not exist`);
    process.exitCode = 1;
    return;
  }

  const sourceReal = realpathSync(sourcePath);
  const live = vaultDbPath();
  const liveReal = existsSync(live) ? realpathSync(live) : resolve(live);
  if (sourceReal === liveReal || (existsSync(live) && statSync(sourceReal).dev === statSync(live).dev && statSync(sourceReal).ino === statSync(live).ino)) throw new VaultRestoreError("Restore source is the live vault database; use a sealed backup snapshot");

  // ── 1. Identify ──────────────────────────────────────────────────────
  const looksEncrypted = sourcePath.endsWith(".age");
  const isEncrypted = isAgeEncrypted(sourcePath);
  if (looksEncrypted && !isEncrypted) {
    console.error(`Error: ${sourcePath} has a .age extension but does not start with the age magic header.`);
    console.error("  Refusing to treat a mis-named file as either plaintext or ciphertext.");
    process.exitCode = 1;
    return;
  }

  // ── 2. Decrypt (as the invoking user) ───────────────────────────────
  const plainPath = join(staging, "vault.db");
  if (isEncrypted) {
    const keyPath = options.ageKeyPath
      ?? join(barryAppSupportDir(), "vault-backup-key.txt");
    ageDecrypt(sourcePath, plainPath, keyPath);
    console.log(`Decrypted ${sourcePath} -> staging`);
  } else {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (existsSync(`${sourcePath}${suffix}`) || existsSync(`${sourceReal}${suffix}`)) throw new VaultRestoreError("Plaintext restore source has SQLite companions; use a sealed single-file backup snapshot");
    }
    copyFileSync(sourceReal, plainPath);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (existsSync(`${sourceReal}${suffix}`)) throw new VaultRestoreError("Restore source became live during staging; use a sealed single-file snapshot");
    }
  }

  // Only the owned copy is opened: even read-only SQLite can create sidecars
  // beside an older WAL-header snapshot. Normalize this disposable copy first.
  const normalized = new Database(plainPath);
  try { if (normalized.pragma("journal_mode=DELETE", { simple: true }) !== "delete") throw new VaultRestoreError("Staged snapshot could not become a standalone database"); }
  finally { normalized.close(); }

  // ── 3a. Verify structurally ──────────────────────────────────────────
  const info = verifySnapshot(plainPath);
  console.log(`Snapshot:    ${info.accounts} accounts, ${info.items} items, tables: ${info.tables.join(", ")}`);

  // ── 3b. Verify by decryption ─────────────────────────────────────────
  const identityName = options.name ?? getActiveIdentity(await getCurrentUser());
  if (!identityName) {
    console.error("Error: No identity specified and no active identity is set — pass --name to verify decryption against it.");
    process.exitCode = 1;
    return;
  }
  let found: IdentityEntry;
  try {
    found = await identityRecords.find(identityName);
  } catch (error) {
    if (!isBarryError(error)) throw error;
    console.error(`Error: ${error.message}`);
    if (error.hint) console.error(`  ${error.hint}`);
    process.exitCode = 1;
    return;
  }
  await verifyDecrypts(plainPath, identityName, found.record.metadata);
  console.log(`Decrypt check: a real item decrypted successfully with ${identityName}'s master password.`);

  // ── 4. Staleness — always reported, refused past the threshold ──────
  const manifest = readManifest(sourcePath);
  const staleness = checkStaleness(manifest, statSync(sourcePath).mtimeMs);
  if (staleness.timestamp) {
    console.log(`Snapshot age: ${staleness.ageDays!.toFixed(1)} days (from manifest, taken ${staleness.timestamp})`);
  } else {
    console.log(`Snapshot age: ${staleness.ageDays!.toFixed(1)} days (from file mtime — no manifest; this backup predates it)`);
  }
  console.log(`Credentials rotated after this snapshot was taken will be stale and must be reissued.`);
  if (staleness.refuse && !options.acceptStale) {
    console.error(
      `Error: snapshot is older than ${MAX_SNAPSHOT_AGE_DAYS} days. Pass --accept-stale to restore anyway.`,
    );
    process.exitCode = 1;
    return;
  }

  // Live comparison, so the operator sees what they are about to overwrite.
  console.log("Live vault: comparison deferred to the stopped, fenced recovery snapshot.");

  if (options.dryRun) {
    console.log("\n--dry-run: would stop the daemon, install this snapshot, and restart. Nothing was changed.");
    return;
  }

  if (!options.force) {
    console.error("\nError: refusing to restore without --force. This overwrites the live vault.");
    process.exitCode = 1;
    return;
  }

  const secret = await vaultBackupSecret();

  // ── 5. Stop the daemon for real ──────────────────────────────────────
  const definitions = join(barryAppSupportDir(), "managed-definitions.json");
  let daemonRef = { label: DAEMON_LABEL, plistPath: DAEMON_PLIST_PATH };
  if (existsSync(definitions)) {
    const { installedServices } = await import("../services/barry.js");
    const management = await installedServices();
    daemonRef = vaultDaemon(management);
  }
  const dbPath = vaultDbPath();
  const nonce = randomUUID();
  // Establish the reopen fence and stage/normalize the replacement BEFORE stop.
  runVaultMaintenance({ action: "prepare", database: dbPath, nonce, snapshot: plainPath });
  let restartFailed = false;
  let stopped = false;
  let safeToRestart = true;
  let restoreFailure: unknown;
  let cleanupFailure: unknown;
  try {
    const daemonPid = daemonServicePid(daemonRef);
    console.log(`\nStopping ${daemonRef.label}...`);
    const stopResult = stopDaemonService(daemonRef);
    if (!stopResult.ok && isDaemonServiceRunning(daemonRef)) throw new VaultRestoreError(`Could not stop the vault daemon: ${stopResult.stderr}`);
    stopped = true;
    try {
      const result = runVaultMaintenance({ action: "replace", database: dbPath, nonce, daemonPid });
      console.log(`Preserved the complete displaced vault at ${result.recovery}`);
    } catch (error) {
      if (String(error).includes("rollback is incomplete")) safeToRestart = false;
      throw error;
    }
  } catch (error) { restoreFailure = error; throw error; } finally {
    // A crashed/incomplete rollback keeps its unique marker and complete-set
    // recovery evidence. Never start a daemon against uncertain canonical files.
    if (safeToRestart) {
      try { runVaultMaintenance({ action: "release", database: dbPath, nonce }); }
      catch (error) { cleanupFailure = error; console.error(`Vault remains stopped: ${String(error)}${restoreFailure ? `; original restore failure: ${String(restoreFailure)}` : ""}`); }
      if (stopped && !cleanupFailure) {
        console.log(`Starting ${daemonRef.label}...`);
        const startResult = startDaemonService(daemonRef);
        if (!startResult.ok) {
          console.error(`Error: failed to restart the daemon: ${startResult.stderr}`);
          console.error(`  Manual recovery: sudo launchctl bootstrap system ${daemonRef.plistPath}`);
          restartFailed = true;
        }
      }
    } else console.error(`Vault remains stopped. Inspect ${dbPath}.maintenance and the reported recovery directory before resuming.`);
  }

  if (cleanupFailure) throw new VaultRestoreError(`Vault maintenance fence could not be released: ${String(cleanupFailure)}`);
  if (restartFailed) {
    process.exitCode = 1;
    return;
  }

  // Liveness that actually opens the database — /health never touches it,
  // so a green /health after a restore proves nothing about whether the
  // restored file is even readable by the daemon's own process.
  const probe = spawnSync(
    "curl",
    [
      "--silent", "--show-error", "--fail", "--max-time", "10",
      "--unix-socket", process.env.VAULT_SOCKET_PATH ?? "/usr/local/var/barry-vault/run/vault.sock",
      "--request", "POST",
      "--header", "@-",
      "--output", "/dev/null",
      "http://localhost/api/backup",
    ],
    { encoding: "utf-8", input: `x-backup-secret: ${secret}\n` },
  );
  if (probe.status !== 0) {
    console.error("Warning: daemon restarted but a real backup request against it failed — the restored file may not be readable.");
    process.exitCode = 1;
    return;
  }
  console.log("Liveness check passed: the daemon opened and read the restored database.");

  console.log(`\nRestore complete: ${sourcePath} -> ${dbPath}`);
}
