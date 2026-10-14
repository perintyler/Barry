import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export interface VaultMaintenanceRequest {
  action: "prepare" | "replace" | "release";
  database: string;
  nonce: string;
  snapshot?: string;
  daemonPid?: number;
  driver: string;
}
export interface VaultMaintenanceResult { recovery?: string; rollbackComplete?: boolean; }

/** Runs in one privileged process; its source is also the sudo helper payload. */
export async function vaultRestoreMaintenance(request: VaultMaintenanceRequest, testing?: {
  account: { uid: number; gid: number };
  boundary?: (phase: string) => void;
}): Promise<VaultMaintenanceResult> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const crypto = await import("node:crypto");
  const child = await import("node:child_process");
  const { default: Database } = await import(request.driver) as { default: typeof import("better-sqlite3") };
  const database = path.resolve(request.database);
  if (!["prepare", "replace", "release"].includes(request.action) || !path.isAbsolute(request.database) || !/^[a-f0-9-]{36}$/.test(request.nonce) || (request.daemonPid !== undefined && (!Number.isSafeInteger(request.daemonPid) || request.daemonPid < 2))) throw new Error("Invalid vault maintenance request");
  const marker = `${database}.maintenance`;
  const ownership = `${database}.owner-lock`;
  const staging = `${database}.restore-${request.nonce}`;
  const names = ["vault.db", "vault.db-wal", "vault.db-shm", "vault.db-journal"];
  const sources = [database, `${database}-wal`, `${database}-shm`, `${database}-journal`];
  const syncDirectory = (name: string): void => { const fd = fs.openSync(name, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  const durable = (name: string, value: unknown): void => {
    const fd = fs.openSync(name, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(name));
  };
  const ownedMarker = (): void => {
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || JSON.parse(fs.readFileSync(marker, "utf8")).nonce !== request.nonce) throw new Error("Vault maintenance marker belongs to another operation");
  };
  if (request.action === "prepare") {
    if (!request.snapshot) throw new Error("Missing staged vault snapshot");
    const source = fs.realpathSync(request.snapshot);
    const live = fs.existsSync(database) ? fs.realpathSync(database) : database;
    if (source === live || (fs.existsSync(database) && fs.statSync(source).dev === fs.statSync(database).dev && fs.statSync(source).ino === fs.statSync(database).ino)) throw new Error("Restore source is the live vault database");
    for (const suffix of ["-wal", "-shm", "-journal"]) if (fs.existsSync(`${request.snapshot}${suffix}`) || fs.existsSync(`${source}${suffix}`)) throw new Error("Restore source must be a sealed single-file snapshot without SQLite companions");
    // Older daemons cannot honor the maintenance fence: upgrade/start them
    // once before allowing an automated replacement, rather than trusting bootout.
    if (fs.existsSync(database) && !fs.existsSync(ownership)) throw new Error("Vault runtime lacks its ownership lock; upgrade and start the managed vault before restoring");
    if (fs.existsSync(database)) {
      const control = new Database(ownership, { readonly: true, fileMustExist: true });
      try { if (control.pragma("application_id", { simple: true }) !== 1112951892) throw new Error("Vault runtime ownership protocol is unsupported; upgrade and start the managed vault before restoring"); }
      finally { control.close(); }
    }
    const fd = fs.openSync(marker, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ nonce: request.nonce, staging })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(marker));
    try {
      fs.mkdirSync(staging, { mode: 0o700 });
      const candidate = path.join(staging, "vault.db");
      fs.copyFileSync(source, candidate, fs.constants.COPYFILE_EXCL);
      for (const suffix of ["-wal", "-shm", "-journal"]) if (fs.existsSync(`${source}${suffix}`)) throw new Error("Restore source became live during staging");
      fs.chmodSync(candidate, 0o600);
      const db = new Database(candidate);
      try {
        if (db.pragma("journal_mode=DELETE", { simple: true }) !== "delete" || db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Staged vault snapshot is not a standalone healthy database");
      } finally { db.close(); }
      durable(path.join(staging, "state.json"), { phase: "prepared", database });
      return {};
    } catch (error) {
      // This operation has not touched the live database. Keep its staging
      // evidence, but release only the marker we just created ourselves.
      ownedMarker(); fs.unlinkSync(marker); syncDirectory(path.dirname(marker)); throw error;
    }
  }
  ownedMarker();
  if (request.action === "release") {
    const state = path.join(`${database}.pre-restore-${request.nonce}`, "recovery.json");
    if (fs.existsSync(state) && !["preserved", "rolled-back", "installed"].includes(JSON.parse(fs.readFileSync(state, "utf8")).phase)) throw new Error("Vault rollback is incomplete; leave daemon stopped and inspect its recovery receipt");
    fs.unlinkSync(marker); syncDirectory(path.dirname(marker)); return {};
  }
  const lock = new Database(ownership, { timeout: 0 });
  let acquired = false;
  const moved: number[] = [];
  let replacementInstalled = false;
  const recovery = `${database}.pre-restore-${request.nonce}`;
  try {
    if (request.daemonPid !== undefined) {
      const deadline = Date.now() + 5000;
      for (;;) {
        try { process.kill(request.daemonPid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
        if (Date.now() >= deadline) throw new Error("Managed vault process is still alive");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    lock.exec("BEGIN IMMEDIATE"); acquired = true;
    const present = sources.filter(name => fs.existsSync(name));
    if (present.length) {
      const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].find(candidate => fs.existsSync(candidate)) ?? "/usr/sbin/lsof";
      const probe = child.spawnSync(lsof, ["-Fpn", "--", ...present], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (probe.error || probe.stderr.trim() || ![0, 1].includes(probe.status ?? -1)) throw new Error("Could not establish that vault database handles are closed");
      if (probe.stdout.trim() || probe.status === 0) throw new Error("Another process still has the vault database open; restore refused");
    }
    fs.mkdirSync(recovery, { mode: 0o700 }); syncDirectory(path.dirname(recovery));
    const hashes: Record<string, string> = {};
    // Preserve the complete old set before canonical names change. Verification
    // gets its own clone, so SQLite never modifies this recovery evidence.
    for (let i = 0; i < sources.length; i++) {
      if (!fs.existsSync(sources[i])) continue;
      const stat = fs.lstatSync(sources[i]);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe vault database component");
      const target = path.join(recovery, names[i]);
      fs.copyFileSync(sources[i], target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
      const fd = fs.openSync(target, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      hashes[names[i]] = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    }
    durable(path.join(recovery, "recovery.json"), { database, hashes, phase: "preserved" });
    if (fs.existsSync(path.join(recovery, "vault.db"))) {
      const clone = path.join(staging, "recovery-check"); fs.mkdirSync(clone, { mode: 0o700 });
      for (const name of Object.keys(hashes)) fs.copyFileSync(path.join(recovery, name), path.join(clone, name));
      const db = new Database(path.join(clone, "vault.db"));
      try { if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Displaced vault recovery copy is corrupt; canonical files unchanged"); } finally { db.close(); }
    }
    const displaced = path.join(recovery, "displaced"); fs.mkdirSync(displaced, { mode: 0o700 });
    try {
      for (let i = 0; i < sources.length; i++) {
        if (!fs.existsSync(sources[i])) continue;
        durable(path.join(recovery, "recovery.json"), { database, hashes, phase: "displacing", moved, next: i });
        fs.renameSync(sources[i], path.join(displaced, names[i])); moved.push(i);
        syncDirectory(path.dirname(database)); syncDirectory(displaced);
        testing?.boundary?.(`displaced-${i}`);
        durable(path.join(recovery, "recovery.json"), { database, hashes, phase: "displacing", moved });
      }
      let account = testing?.account;
      if (!account) {
        const uid = child.spawnSync("/usr/bin/id", ["-u", "_barryvault"], { encoding: "utf8" });
        const gid = child.spawnSync("/usr/bin/id", ["-g", "_barryvault"], { encoding: "utf8" });
        if (uid.status !== 0 || gid.status !== 0 || !/^\d+\s*$/.test(uid.stdout) || !/^\d+\s*$/.test(gid.stdout)) throw new Error("Vault service account is unavailable");
        account = { uid: Number(uid.stdout), gid: Number(gid.stdout) };
      }
      const candidate = path.join(staging, "vault.db");
      fs.chownSync(candidate, account.uid, account.gid); fs.chmodSync(candidate, 0o640);
      durable(path.join(recovery, "recovery.json"), { database, hashes, phase: "installing", moved });
      fs.renameSync(candidate, database); replacementInstalled = true;
      syncDirectory(path.dirname(database)); syncDirectory(staging);
      testing?.boundary?.("installed");
      durable(path.join(recovery, "recovery.json"), { database, hashes, phase: "installed", moved });
      return { recovery, rollbackComplete: true };
    } catch (error) {
      try {
        testing?.boundary?.("rollback");
        if (replacementInstalled) fs.renameSync(database, path.join(staging, "failed-replacement.db"));
        for (const i of [...moved].reverse()) fs.renameSync(path.join(displaced, names[i]), sources[i]);
        syncDirectory(path.dirname(database)); syncDirectory(displaced); syncDirectory(staging);
        durable(path.join(recovery, "recovery.json"), { database, hashes, phase: "rolled-back" });
      } catch (rollback) {
        throw new Error(`Vault restore failed and rollback is incomplete; leave daemon stopped. Recovery: ${recovery}. Original: ${String(error)}. Rollback: ${String(rollback)}`);
      }
      throw error;
    }
  } finally { if (acquired) lock.exec("ROLLBACK"); lock.close(); }
}

/** No secrets enter argv: this request contains paths, a nonce and an observed PID only. */
export function runVaultMaintenance(request: Omit<VaultMaintenanceRequest, "driver">): VaultMaintenanceResult {
  const driver = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;
  const script = `(${vaultRestoreMaintenance.toString()})(JSON.parse(process.argv[1])).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});`;
  const result = spawnSync("sudo", [process.execPath, "--input-type=module", "-e", script, JSON.stringify({ ...request, driver })], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  if (result.error || result.status !== 0) throw new Error(`Vault maintenance failed: ${(result.stderr || result.error?.message || "helper failed").trim()}`);
  return JSON.parse(result.stdout) as VaultMaintenanceResult;
}
