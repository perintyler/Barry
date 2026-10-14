import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { instanceEnvValue } from "@barry-rocks/sdk/services";
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

// Show snapshot identity and item counts before restore so operators can compare the backup with the live vault.
// Rationale: docs/decisions/0009-runtime-and-fixture-invariants.md#note-007
export interface VaultBackupManifest {
  /** ISO-8601, set at snapshot time — NOT the file's mtime after any copy. */
  timestamp: string;
  accounts: number;
  items: number;
  encrypted: boolean;
  /** From sqlite_master at snapshot time, not hardcoded — stays correct if the schema changes. */
  tables: string[];
}

/**
 * Where the vault keeps its database.
 *
 * Reported in diagnostics only — the backup no longer opens this file. It is
 * 0600 `_barryvault` and stays that way; see `snapshot()` for why reading it
 * from here was both impossible and wrong.
 */
const VAULT_DB = process.env.VAULT_DB_PATH
  ?? join(process.env.DATA_DIR ?? "/usr/local/var/barry-vault", "vault.db");

/**
 * The daemon's unix socket — how the backup actually reaches the vault.
 *
 * Matches `VAULT_SOCKET_PATH` in the generated LaunchDaemon plist. The socket
 * is 0660 `_barryvault:_barryvault`, and group membership is what grants
 * access; unlike the database file, that is a grant the daemon cannot undo on
 * its next checkpoint.
 */
const VAULT_SOCKET = process.env.VAULT_SOCKET_PATH
  ?? join(process.env.DATA_DIR ?? "/usr/local/var/barry-vault", "run", "vault.sock");

export interface VaultBackupResult {
  path: string;
  encrypted: boolean;
  accounts: number;
  items: number;
}

export class VaultBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultBackupError";
  }
}

/**
 * Whether there is a vault on this machine to back up.
 *
 * Now that the daemon takes the snapshot, this checks for its SOCKET rather
 * than the database file. That makes it a liveness check, which the previous
 * version deliberately was not — the old comment argued that tying the backup
 * to the service being up would skip a backup exactly when the vault had
 * crashed. That reasoning held while the snapshot came from the file; it no
 * longer can, because a stopped daemon cannot VACUUM anything. The protection
 * against a silent skip now lives in the distinction below, and in the `false`
 * branch of `backupVault`'s caller, which reports SKIPPED loudly.
 *
 * The important property is unchanged and is the reason this is not
 * `existsSync`: "no vault on this machine" and "vault present but we cannot
 * reach it" must not look alike. A machine that was never set up returns
 * false; a socket that exists but is unreachable — wrong group, stale file
 * after a crash — throws. Collapsing those is how a permissions fault reports
 * itself as "nothing to back up" forever, which is the failure this whole
 * change exists to undo.
 */
export function isVaultRunning(): boolean {
  let stats;
  try {
    stats = statSync(VAULT_SOCKET);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new VaultBackupError(
      `Vault socket at ${VAULT_SOCKET} exists but is unreachable: ${(err as Error).message}`,
    );
  }

  // A regular file here means a crash left the path behind without the daemon
  // reclaiming it. Backing up would fail anyway; say why.
  if (!stats.isSocket()) {
    throw new VaultBackupError(
      `Vault socket path ${VAULT_SOCKET} exists but is not a socket — the daemon may have crashed`,
    );
  }
  return true;
}

/** The store this backup covers, for error messages and diagnostics. */
export function vaultDbPath(): string {
  return VAULT_DB;
}

export async function vaultBackupSecret(): Promise<string> {
  let secret: string;
  try {
    ({ VAULT_BACKUP_SECRET: secret } = await installationSecrets(["VAULT_BACKUP_SECRET"]));
  } catch {
    throw new VaultBackupError("VAULT_BACKUP_SECRET could not be resolved from installation bindings");
  }
  if (!secret) {
    throw new VaultBackupError(
      "VAULT_BACKUP_SECRET is not configured — the vault daemon will refuse the backup request",
    );
  }

  if (/[\r\n]/.test(secret)) throw new VaultBackupError("VAULT_BACKUP_SECRET must be a single-line credential");
  return secret;
}

/**
 * Ask the vault daemon to snapshot itself, and write what it sends back.
 *
 * This deliberately does NOT read vault.db. The database is 0600 _barryvault
 * and the backup runs as the invoking user, so a file-level read fails — but
 * widening the mode is the wrong repair twice over. SQLite recreates
 * -wal/-shm at the daemon's umask on every checkpoint, so the grant has to be
 * repeated forever; and a read that misses the -wal does not fail, it returns
 * a SUBSET. Measured on a scratch database shaped like the live one: 4,959 of
 * 5,001 rows, opening cleanly and passing integrity_check. A backup that is
 * quietly short is worse than one that is loudly absent.
 *
 * The daemon runs VACUUM INTO on the same connection that owns the WAL, so
 * what comes back is consistent by construction and the backup user never
 * needs read access to the store at all.
 */
async function snapshot(destPath: string): Promise<void> {
  const secret = await vaultBackupSecret();

  const result = spawnSync(
    "curl",
    [
      "--silent", "--show-error", "--fail",
      "--max-time", "120",
      "--unix-socket", VAULT_SOCKET,
      "--request", "POST",
      "--header", "@-",
      "--output", destPath,
      "http://localhost/api/backup",
    ],
    // A Buffer, not a string: spawnSync encodes string input with `encoding`,
    // and "buffer" is not a text encoding ("Unknown encoding: buffer").
    { encoding: "buffer", input: Buffer.from(`x-backup-secret: ${secret}\n`) },
  );

  if (result.error) {
    throw new VaultBackupError(`Vault snapshot request failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.from(result.stderr ?? "").toString("utf8").trim();
    throw new VaultBackupError(
      `Vault snapshot request failed (curl exit ${result.status})${stderr ? `: ${stderr}` : ""}`,
    );
  }
  // --fail plus --output means a rejected request can still leave a zero-byte
  // file behind. verify() would report that as a corrupt snapshot; saying what
  // actually happened is more useful.
  if (!existsSync(destPath) || statSync(destPath).size === 0) {
    throw new VaultBackupError("Vault snapshot request returned no data");
  }
}

/** Verifies the snapshot is a well-formed SQLite file and reports row counts + schema. */
function verify(snapshotPath: string): { accounts: number; items: number; tables: string[] } {
  let db: Database.Database;
  try {
    db = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new VaultBackupError(
      `Vault snapshot verification could not open the snapshot: ${(err as Error).message}`,
    );
  }

  try {
    const ok = (db.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]?.integrity_check;
    if (ok !== "ok") {
      throw new VaultBackupError(`Vault snapshot failed integrity_check: ${ok}`);
    }

    const accounts = (db.prepare("select count(*) c from accounts").get() as { c: number }).c;
    const items = (db.prepare("select count(*) c from items").get() as { c: number }).c;
    const tables = (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as Array<{ name: string }>)
      .map((r) => r.name);

    // A snapshot with no accounts means we backed up an empty or wrong database —
    // the failure mode that silently produces a valid-looking useless file.
    if (accounts === 0) {
      throw new VaultBackupError("Vault snapshot contains no accounts — refusing to write an empty backup");
    }
    return { accounts, items, tables };
  } catch (err) {
    if (err instanceof VaultBackupError) throw err;
    throw new VaultBackupError(`Vault snapshot verification failed: ${(err as Error).message}`);
  } finally {
    db.close();
  }
}

/**
 * The age public key a vault snapshot is encrypted to: the process's, else the
 * instance env file's. The nightly job is handed it as a declared secret, but
 * a `barry db backup` typed in a shell is not, and left the vault in plaintext.
 */
function ageRecipient(): string | undefined {
  return process.env.BARRY_VAULT_AGE_RECIPIENT?.trim() || instanceEnvValue("BARRY_VAULT_AGE_RECIPIENT")?.trim() || undefined;
}

function hasAge(): boolean {
  return spawnSync("age", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * Wraps the snapshot with `age` when BARRY_VAULT_AGE_RECIPIENT is set.
 *
 * The vault is zero-knowledge, so the snapshot already contains only ciphertext;
 * this second layer matters when backups leave the machine. Recipient-based
 * encryption means no private key is needed to write a backup, so scheduled runs
 * never hold decryption material.
 */
function encrypt(plainPath: string): string {
  const recipient = ageRecipient();
  if (!recipient) return plainPath;

  if (!hasAge()) {
    throw new VaultBackupError(
      "BARRY_VAULT_AGE_RECIPIENT is set but `age` is not installed (brew install age)",
    );
  }

  const encPath = `${plainPath}.age`;
  const res = spawnSync("age", ["-r", recipient, "-o", encPath, plainPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    throw new VaultBackupError(`age encryption failed: ${(res.stderr || "age exited unsuccessfully").trim()}`);
  }
  if (!existsSync(encPath) || statSync(encPath).size === 0) {
    throw new VaultBackupError("age produced an empty file");
  }

  unlinkSync(plainPath);
  return encPath;
}

/**
 * Snapshots the vault into `destDir`, verifies it, and optionally age-encrypts it.
 *
 * A store of its own: the vault is SQLite owned by the `_barryvault` service
 * account, which no other backup path touches.
 */
export async function backupVault(destDir: string): Promise<VaultBackupResult> {
  // No isVaultRunning() gate here: the caller (db.ts) already checks it to
  // decide whether to attempt a backup at all versus report SKIPPED, and
  // snapshot() below throws its own clear VaultBackupError if the socket is
  // unreachable when the request is actually made. A second check here would
  // only add a TOCTOU-prone duplicate, not a real guarantee.

  // Captured before anything can fail, so the manifest's timestamp always
  // means "when this snapshot was taken" — not "whenever verify() happened
  // to finish" and never the final file's mtime, which `rename`/`age` both
  // disturb.
  const timestamp = new Date().toISOString();

  // Staged beside the final file so VACUUM INTO writes to the same filesystem,
  // then renamed into place. Unique per run so concurrent backups cannot collide.
  const localPath = join(destDir, "vault.db");
  const stagingPath = join(destDir, `.vault-${process.pid}-${Date.now()}.db`);

  try {
    // VACUUM INTO refuses to overwrite, so a leftover staging file would fail the run.
    if (existsSync(stagingPath)) unlinkSync(stagingPath);

    await snapshot(stagingPath);
    const { accounts, items, tables } = verify(stagingPath);

    if (!existsSync(stagingPath) || statSync(stagingPath).size === 0) {
      throw new VaultBackupError("Vault snapshot was written as an empty file");
    }

    renameSync(stagingPath, localPath);

    const finalPath = encrypt(localPath);
    const encrypted = finalPath !== localPath;

    // Named after vault.db, not the (possibly .age) final path: a restore
    // needs to find this before it knows whether the snapshot is encrypted,
    // and the manifest itself is never worth encrypting — accounts/items
    // counts and a table list reveal nothing the counts printed to a
    // terminal every backup run don't already reveal.
    const manifest: VaultBackupManifest = { timestamp, accounts, items, encrypted, tables };
    writeFileSync(join(destDir, "vault.db.meta.json"), JSON.stringify(manifest, null, 2));

    return { path: finalPath, encrypted, accounts, items };
  } finally {
    if (existsSync(stagingPath)) unlinkSync(stagingPath);
  }
}
