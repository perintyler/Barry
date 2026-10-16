import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  deriveKeys,
  generateKdfSalt,
  generateSymmetricKey,
  encryptSymmetricKey,
  encrypt as vaultEncrypt,
} from "@barry-rocks/sdk/internal/vault";

// ESM cannot spy on a named export (vi.spyOn(await import("node:child_process"),
// "spawnSync") throws "Cannot redefine property"), so spawnSync is mocked at
// module level like vault-backup.test.ts does. Default passthrough runs the
// REAL binary for age/sudo-less calls this suite doesn't care about; the one
// test that needs to observe sudo install/rm calls overrides it per-test.
const installation = vi.hoisted(() => vi.fn());
vi.mock("@barry-rocks/sdk/internal/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/services")>(),
  installationSecrets: installation,
}));
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

// Real crypto throughout: this command's whole reason for existing beyond
// "copy a file" is bags/vault/README.md's own lesson — integrity_check and
// row counts prove a file, not that you can still decrypt it. A mocked
// decrypt could never catch a wrong master password, which is the actual
// failure mode this command exists to catch BEFORE it overwrites the live
// vault. So every test that touches verification builds a REAL account and a
// REAL encrypted item, exactly as VaultClient.register would.

const MASTER_PASSWORD = "correct-horse-battery-staple";
const EMAIL = "bgoode-vault@example.com";

let stagingRoot: string;
let sourceDir: string;
let vaultDataDir: string;

const maintenance = vi.hoisted(() => vi.fn((_request: { action: string }) => ({ recovery: "preserved-vault" })));
vi.mock("./vault-restore-maintenance.js", () => ({ runVaultMaintenance: maintenance }));

const launchctl = vi.hoisted(() => ({
  daemonServicePid: vi.fn(() => undefined),
  isDaemonServiceRunning: vi.fn(() => true),
  stopDaemonService: vi.fn(() => ({ ok: true, stderr: "" })),
  startDaemonService: vi.fn(() => ({ ok: true, stderr: "" })),
}));
vi.mock("./vault-daemon.js", () => launchctl);

// An explicit return type permits assigning a real fixture row after initialization.
const identityRow = vi.hoisted((): { current: unknown } => ({ current: null }));
vi.mock("@barry-rocks/identities-bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/identities-bag")>();
  const { BarryError } = await import("@barry-rocks/sdk");
  return {
    ...actual,
    identityRecords: {
      ...actual.identityRecords,
      find: vi.fn(async (name: string) => {
        if (!identityRow.current) throw new BarryError("not_found", `Identity "${name}" not found`);
        return { record: identityRow.current, source: "db", dir: null, isDefault: true };
      }),
    },
  };
});
vi.mock("../lib/current-user.js", () => ({
  getCurrentUser: vi.fn(async () => ({ id: 1 })),
  getActiveIdentity: vi.fn(() => "bgoode"),
}));

// Inlined literal, not a reference to MASTER_PASSWORD below: vi.hoisted runs
// before top-level const declarations, so referencing it here would throw
// "Cannot access before initialization". Kept in sync by eye — both name the
// same fixture password.
// Typed return rather than `as`, so a test can clear either value.
// `email` is the vault-<name>-email entry a NAMED vault keeps beside its
// credentials; every other account answers with the master password.
const keychainValue = vi.hoisted((): { current: string | null; email: string | null } => ({
  current: "correct-horse-battery-staple",
  email: null,
}));
vi.mock("@barry-rocks/sdk/internal/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/env")>(),
  KeychainProvider: class {
    async get(_service: string, account: string): Promise<string | null> {
      return account.endsWith("-email") ? keychainValue.email : keychainValue.current;
    }
  },
}));

/** Builds a vault db with one real account and one real encrypted item. */
async function makeRealVaultDb(
  path: string,
  opts: { email?: string; masterPassword?: string; itemPassword?: string } = {},
): Promise<{ kdfSalt: string }> {
  const email = opts.email ?? EMAIL;
  const masterPassword = opts.masterPassword ?? MASTER_PASSWORD;
  const kdfSalt = generateKdfSalt();
  const { masterPasswordHash, encKey, macKey } = await deriveKeys(masterPassword, email, kdfSalt);
  const symKey = generateSymmetricKey();
  const encryptedKey = encryptSymmetricKey(symKey, encKey, macKey);
  const itemEncKey = symKey.subarray(0, 32);
  const itemMacKey = symKey.subarray(32, 64);
  const itemCiphertext = vaultEncrypt(opts.itemPassword ?? "s3cr3t-api-key", itemEncKey, itemMacKey);

  const db = new Database(path);
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      master_password_hash TEXT NOT NULL, encrypted_key TEXT NOT NULL,
      kdf_salt TEXT
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL,
      password TEXT
    );
  `);
  db.prepare("insert into accounts (id,email,master_password_hash,encrypted_key,kdf_salt) values (?,?,?,?,?)")
    .run("acct-1", email.toLowerCase(), masterPasswordHash, encryptedKey, kdfSalt);
  db.prepare("insert into items (id,account_id,name,password) values (?,?,?,?)")
    .run("item-1", "acct-1", "API_KEY", itemCiphertext);
  db.close();
  return { kdfSalt };
}


beforeEach(() => {
  installation.mockReset();
  installation.mockResolvedValue({ VAULT_BACKUP_SECRET: "configured-backup-secret" });
  stagingRoot = mkdtempSync(join(tmpdir(), "vault-restore-test-"));
  sourceDir = join(stagingRoot, "backup");
  vaultDataDir = join(stagingRoot, "vault-data");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(vaultDataDir, { recursive: true });
  process.env.VAULT_DB_PATH = join(vaultDataDir, "vault.db");
  keychainValue.current = MASTER_PASSWORD;
  keychainValue.email = EMAIL;
  identityRow.current = { id: 5, name: "bgoode", metadata: { vault: "bgoode" } };
  maintenance.mockReset(); maintenance.mockReturnValue({ recovery: "preserved-vault" });
  launchctl.isDaemonServiceRunning.mockReturnValue(true);
  launchctl.stopDaemonService.mockReturnValue({ ok: true, stderr: "" });
  launchctl.startDaemonService.mockReturnValue({ ok: true, stderr: "" });
  // Default: every sudo call the --force path makes (install, rm -f) reports
  // success without touching a real sudo binary. Tests that care about WHICH
  // calls happened override this per-test.
  spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  rmSync(stagingRoot, { recursive: true, force: true });
  delete process.env.VAULT_DB_PATH;
  delete process.env.VAULT_BACKUP_SECRET;
  vi.clearAllMocks();
});

async function load() {
  vi.resetModules();
  return await import("./vault-restore.js");
}

describe("vaultRestoreCommand — identify", () => {
  it("names the default age key path and explains using an offline copy", async () => {
    vi.stubEnv("BARRY_HOME", stagingRoot);
    const encrypted = join(sourceDir, "vault.db.age");
    writeFileSync(encrypted, "age-encryption.org/v1\n");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { barryAppSupportDir } = await import("@barry-rocks/sdk/services");
      const keyPath = join(barryAppSupportDir(), "vault-backup-key.txt");
      const { vaultRestoreCommand } = await load();
      await vaultRestoreCommand(encrypted, { name: "bgoode", dryRun: true });
      expect(process.exitCode).toBe(1);
      const message = errorSpy.mock.calls.flat().join(" ");
      expect(message).toContain(`Age private key not found at ${keyPath}`);
      expect(message).toContain(encrypted);
      expect(message).toContain("--age-key-path <key file> with your offline copy");
      expect(message).toContain(`put it at ${keyPath} for this restore`);
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(launchctl.stopDaemonService).not.toHaveBeenCalled();
    } finally {
      process.exitCode = 0;
      errorSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
  it("refuses a file named .age that does not have the age magic header", async () => {
    const fake = join(sourceDir, "vault.db.age");
    writeFileSync(fake, "this is not actually age-encrypted");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(fake, { name: "bgoode", dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/magic header/);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });
});

describe("vaultRestoreCommand — verification (real crypto)", () => {
  it("dry-run passes for a genuinely valid, correctly-decryptable snapshot", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    await makeRealVaultDb(snapshotPath);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode", dryRun: true });

    expect(process.exitCode ?? 0).toBe(0);
    const out = logSpy.mock.calls.flat().join("\n");
    expect(out).toMatch(/1 accounts, 1 items/);
    expect(out).toMatch(/decrypted successfully/);
    // Dry-run must never touch the daemon.
    expect(launchctl.stopDaemonService).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  // The exact case bags/vault/README.md warns about: a structurally perfect
  // file that is useless because the caller holds the wrong master password.
  // integrity_check and row counts cannot catch this — only a real decrypt can.
  it("fails when the master password is wrong, even though the file is structurally perfect", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    await makeRealVaultDb(snapshotPath, { masterPassword: "the-wrong-password" });
    keychainValue.current = MASTER_PASSWORD; // what we'll actually try to decrypt with
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode", dryRun: true });

    expect(process.exitCode).toBe(1);
    const out = errorSpy.mock.calls.flat().join(" ");
    expect(out).toMatch(/WRONG MASTER PASSWORD|MAC verification failed/);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });

  // A named vault (`vault: bgoode` in identity.yaml) carries no email; it lives
  // in Keychain as vault-bgoode-email. Verification used to look up
  // vaultConfig.email — "" for every named vault — and fail with "No account
  // for  in this snapshot" no matter how good the backup was.
  it("verifies a NAMED-vault identity, finding its email in Keychain", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    await makeRealVaultDb(snapshotPath);
    identityRow.current = { id: 5, name: "bgoode", metadata: { vault: "bgoode" } };
    keychainValue.email = EMAIL;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode", dryRun: true });

    expect(errorSpy.mock.calls.flat().join(" ")).not.toMatch(/No account for/);
    expect(process.exitCode ?? 0).toBe(0);
    expect(logSpy.mock.calls.flat().join("\n")).toMatch(/decrypted successfully/);
    process.exitCode = 0;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("names the missing Keychain email for a named vault instead of an empty account", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    await makeRealVaultDb(snapshotPath);
    keychainValue.email = null;
    identityRow.current = { id: 5, name: "bgoode", metadata: { vault: "bgoode" } };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode", dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/no account email \(keychain barry\/vault-bgoode-email\)/);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });

  it("fails when no account in the snapshot matches the identity's vault email", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    await makeRealVaultDb(snapshotPath, { email: "someone-else@example.com" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode", dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/No account for/);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });

  it("refuses a snapshot with zero accounts", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    const db = new Database(snapshotPath);
    db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT); CREATE TABLE items (id TEXT PRIMARY KEY, account_id TEXT, password TEXT);");
    db.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode", dryRun: true });

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });

  it("fails loudly on a corrupt (non-SQLite) file", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    writeFileSync(snapshotPath, "not a database at all");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode", dryRun: true });

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });
});

describe("vaultRestoreCommand — staleness", () => {
  it("always prints the age, even for a fresh snapshot with no threshold concern", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    await makeRealVaultDb(snapshotPath);
    writeFileSync(
      join(sourceDir, "vault.db.meta.json"),
      JSON.stringify({ timestamp: new Date().toISOString(), accounts: 1, items: 1, encrypted: false, tables: ["accounts", "items"] }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode", dryRun: true });

    expect(logSpy.mock.calls.flat().join("\n")).toMatch(/Snapshot age:/);
    expect(process.exitCode ?? 0).toBe(0);
    logSpy.mockRestore();
  });

  it("refuses a snapshot older than 30 days without --accept-stale", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    await makeRealVaultDb(snapshotPath);
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    writeFileSync(
      join(sourceDir, "vault.db.meta.json"),
      JSON.stringify({ timestamp: old, accounts: 1, items: 1, encrypted: false, tables: ["accounts", "items"] }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode", dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/older than 30 days/);
    process.exitCode = 0;
    errorSpy.mockRestore();
  });

  it("accepts an old snapshot when --accept-stale is passed", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    await makeRealVaultDb(snapshotPath);
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    writeFileSync(
      join(sourceDir, "vault.db.meta.json"),
      JSON.stringify({ timestamp: old, accounts: 1, items: 1, encrypted: false, tables: ["accounts", "items"] }),
    );

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode", dryRun: true, acceptStale: true });

    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("vaultRestoreCommand — refuses without --force", () => {
  it("verifies successfully but does not touch the daemon without --force", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    await makeRealVaultDb(snapshotPath);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode" }); // no dryRun, no force

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/--force/);
    expect(launchctl.stopDaemonService).not.toHaveBeenCalled();
    process.exitCode = 0;
    errorSpy.mockRestore();
  });
});

describe("vaultRestoreCommand — stop/start ordering", () => {
  it("requires the installation credential before stopping or installing", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    await makeRealVaultDb(snapshotPath);
    process.env.VAULT_BACKUP_SECRET = "unrelated-shell-secret";
    installation.mockRejectedValue(new Error("private-backend-details"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { vaultRestoreCommand } = await load();
      await vaultRestoreCommand(snapshotPath, { name: "bgoode", force: true });
      expect(process.exitCode).toBe(1);
      expect(launchctl.stopDaemonService).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/VAULT_BACKUP_SECRET/);
      expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("private-backend-details");
    } finally {
      process.exitCode = 0;
      errorSpy.mockRestore();
    }
  });

  // The whole reason this must be stop-then-install-then-start rather than a
  // single restart call: kickstart -k never gives a window where nothing
  // holds the database file open. This pins that the DAEMON IS STOPPED
  // before any install/rm command runs, by asserting call order rather than
  // just call presence — a reorder here would silently reintroduce the WAL
  // corruption hazard.
  it("stops the daemon before attempting to install, and starts it again after", async () => {
    const snapshotPath = join(sourceDir, "vault.db");
    await makeRealVaultDb(snapshotPath);

    const order: string[] = [];
    launchctl.stopDaemonService.mockImplementation(() => {
      order.push("stop");
      return { ok: true, stderr: "" };
    });
    launchctl.startDaemonService.mockImplementation(() => {
      order.push("start");
      return { ok: true, stderr: "" };
    });

    maintenance.mockImplementation(request => { if (request.action === "replace") order.push("install"); return { recovery: "preserved-vault" }; });
    spawnSyncMock.mockImplementation((_cmd: string, _args: string[]) => {
      return { status: 0, stdout: "", stderr: "" };
    });

    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(snapshotPath, { name: "bgoode", force: true });

    const stopIdx = order.indexOf("stop");
    const installIdx = order.indexOf("install");
    const startIdx = order.indexOf("start");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThan(stopIdx);
    expect(startIdx).toBeGreaterThan(installIdx);
    expect(installation).toHaveBeenCalledWith(["VAULT_BACKUP_SECRET"]);
    const probe = spawnSyncMock.mock.calls.find(([command]) => command === "curl");
    expect(probe).toBeDefined();
    expect(probe![1]).toContain("@-");
    expect(probe![1].join(" ")).not.toContain("configured-backup-secret");
    expect(probe![2].input).toBe("x-backup-secret: configured-backup-secret\n");
  });
});

it("selects the observed managed plist, falling back to the legacy daemon", async () => {
  const { vaultDaemon } = await import("../services/system.js");
  const { openInstance } = await import("@barry-rocks/sdk/internal/services");
  const { ServiceManagement } = await import("@barry-rocks/mcp-bag");
  const root = mkdtempSync(join(tmpdir(), "vault-daemon-label-"));
  try {
    const instance = openInstance(root); const refuse = () => { throw new Error("unexpected launchd call"); };
    const manager = new ServiceManagement(instance, [{ name: "vault.api", domain: "system", user: "_barryvault", directory: root, command: ["/usr/bin/true"], plistDirectory: root, logDirectory: root }], { inspect: refuse, load: refuse, unload: async () => refuse(), enable: refuse, start: refuse });
    expect(vaultDaemon(manager)).toEqual({ label: "com.barry.bag.vault.api", plistPath: join(root, "com.barry.bag.vault.api.plist") });
    const label = manager.label("vault.api"); writeFileSync(join(root, `${label}.plist`), "plist");
    expect(vaultDaemon(manager)).toEqual({ label, plistPath: join(root, `${label}.plist`) });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("refuses a source alias to the live vault before any SQLite probe, maintenance or stop", async () => {
  const live = process.env.VAULT_DB_PATH!;
  await makeRealVaultDb(live);
  const alias = join(sourceDir, "alias.db"); symlinkSync(live, alias);
  const before = readFileSync(live);
  const pragma = vi.spyOn(Database.prototype, "pragma");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { vaultRestoreCommand } = await load();
    await vaultRestoreCommand(alias, { name: "bgoode", force: true });
    expect(pragma).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
    expect(launchctl.stopDaemonService).not.toHaveBeenCalled();
    expect(readFileSync(live)).toEqual(before);
    expect(error.mock.calls.flat().join(" ")).toMatch(/source is the live vault/);
  } finally { process.exitCode = 0; pragma.mockRestore(); error.mockRestore(); }
});

it("rejects a WAL-backed source without opening or modifying any original component", async () => {
  const source = join(sourceDir, "vault.db"); await makeRealVaultDb(source);
  const writer = new Database(source); writer.exec("PRAGMA journal_mode=WAL; UPDATE items SET name='uncheckpointed';");
  const paths = [source, `${source}-wal`, `${source}-shm`], before = paths.map(path => readFileSync(path));
  const pragma = vi.spyOn(Database.prototype, "pragma"), error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { vaultRestoreCommand } = await load(); await vaultRestoreCommand(source, { name: "bgoode", dryRun: true });
    expect(pragma).not.toHaveBeenCalled(); expect(maintenance).not.toHaveBeenCalled(); expect(launchctl.stopDaemonService).not.toHaveBeenCalled();
    for (let i = 0; i < paths.length; i++) expect(readFileSync(paths[i])).toEqual(before[i]);
    expect(error.mock.calls.flat().join(" ")).toMatch(/SQLite companions/);
  } finally { process.exitCode = 0; pragma.mockRestore(); error.mockRestore(); writer.close(); }
});

it("verifies a sealed plaintext snapshot using only its owned copy on dry run", async () => {
  const source = join(sourceDir, "vault.db"); await makeRealVaultDb(source);
  const before = readFileSync(source);
  const { vaultRestoreCommand } = await load(); await vaultRestoreCommand(source, { name: "bgoode", dryRun: true });
  expect(readFileSync(source)).toEqual(before); expect(existsSync(`${source}-wal`)).toBe(false); expect(existsSync(`${source}-shm`)).toBe(false);
  expect(maintenance).not.toHaveBeenCalled(); expect(launchctl.stopDaemonService).not.toHaveBeenCalled();
});
