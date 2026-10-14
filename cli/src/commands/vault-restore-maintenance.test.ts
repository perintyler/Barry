import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireVaultOwnership } from "../../../bags/vault/src/ownership.js";
import { vaultRestoreMaintenance, type VaultMaintenanceRequest } from "./vault-restore-maintenance.js";

const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const driver = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;
const account = { uid: process.getuid!(), gid: process.getgid!() };
function fixture(): VaultMaintenanceRequest {
  const root = mkdtempSync(join(tmpdir(), "vr-")); roots.push(root);
  const database = join(root, "vault.db"), snapshot = join(root, "replacement.db");
  const lock = new Database(`${database}.owner-lock`); lock.pragma("application_id=1112951892"); lock.close();
  const replacement = new Database(snapshot);
  replacement.exec("CREATE TABLE items(value TEXT); INSERT INTO items VALUES('replacement');"); replacement.close();
  return { action: "prepare", database, snapshot, nonce: "11111111-1111-4111-8111-111111111111", driver };
}
async function writer(database: string) {
  const script = `import Database from ${JSON.stringify(driver)};const db=new Database(process.argv[1]);db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(value TEXT); INSERT INTO items VALUES('wal-only');");process.stdout.write('ready\\n');setInterval(()=>db.prepare("SELECT * FROM items").get(),1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, database], { stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  let stderr = ""; child.stderr.on("data", value => { stderr += value; });
  await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error(stderr); })]);
  return child;
}
function values(path: string) { const db = new Database(path, { readonly: true }); try { return db.prepare("SELECT value FROM items").all(); } finally { db.close(); } }

it("refuses an independent WAL writer despite a reported managed daemon stop, without changing the complete live set", async () => {
  const request = fixture(); await writer(request.database);
  const paths = [request.database, `${request.database}-wal`, `${request.database}-shm`];
  const before = paths.map(path => readFileSync(path));
  await vaultRestoreMaintenance(request);
  await expect(vaultRestoreMaintenance({ ...request, action: "replace" }, { account })).rejects.toThrow(/still has the vault database open/);
  for (let i = 0; i < paths.length; i++) expect(readFileSync(paths[i])).toEqual(before[i]);
  await vaultRestoreMaintenance({ ...request, action: "release" });
});

it("preserves a killed writer's committed WAL rows and installs only the replacement, without modifying recovery evidence", async () => {
  const request = fixture(), child = await writer(request.database);
  child.kill("SIGKILL"); await once(child, "exit");
  expect(existsSync(`${request.database}-wal`)).toBe(true);
  const old = [request.database, `${request.database}-wal`, `${request.database}-shm`].map(path => readFileSync(path));
  await vaultRestoreMaintenance(request);
  const result = await vaultRestoreMaintenance({ ...request, action: "replace", daemonPid: child.pid }, { account });
  expect(values(request.database)).toEqual([{ value: "replacement" }]);
  const names = ["vault.db", "vault.db-wal", "vault.db-shm"];
  for (let i = 0; i < names.length; i++) expect(readFileSync(join(result.recovery!, names[i]))).toEqual(old[i]);
  expect(values(join(`${request.database}.restore-${request.nonce}`, "recovery-check", "vault.db"))).toEqual([{ value: "wal-only" }]);
  await vaultRestoreMaintenance({ ...request, action: "release" });
  expect(existsSync(`${request.database}-wal`)).toBe(false);
  expect(existsSync(`${request.database}-shm`)).toBe(false);
});

it.each(["displaced-0", "displaced-1", "displaced-2", "installed"])("rolls back the complete old set on failure at %s", async phase => {
  const request = fixture(), child = await writer(request.database); child.kill("SIGKILL"); await once(child, "exit");
  const paths = [request.database, `${request.database}-wal`, `${request.database}-shm`], before = paths.map(path => readFileSync(path));
  await vaultRestoreMaintenance(request);
  await expect(vaultRestoreMaintenance({ ...request, action: "replace" }, { account, boundary: point => { if (point === phase) throw new Error(`fault ${phase}`); } })).rejects.toThrow(`fault ${phase}`);
  for (let i = 0; i < paths.length; i++) expect(readFileSync(paths[i])).toEqual(before[i]);
  await vaultRestoreMaintenance({ ...request, action: "release" });
});

it("keeps a failed rollback fenced and never releases an occupied or foreign maintenance marker", async () => {
  const request = fixture(), child = await writer(request.database); child.kill("SIGKILL"); await once(child, "exit");
  await vaultRestoreMaintenance(request);
  await expect(vaultRestoreMaintenance({ ...request, action: "replace" }, { account, boundary: point => { if (["displaced-1", "rollback"].includes(point)) throw new Error(point); } })).rejects.toThrow(/rollback is incomplete/);
  await expect(vaultRestoreMaintenance({ ...request, action: "release" })).rejects.toThrow(/rollback is incomplete/);
  expect(() => acquireVaultOwnership(request.database)).toThrow(/maintenance is active/);
  await expect(vaultRestoreMaintenance({ ...request, action: "release", nonce: "22222222-2222-4222-8222-222222222222" })).rejects.toThrow(/belongs to another/);
});

it("blocks cooperating reopeners and leaves an existing marker untouched", async () => {
  const request = fixture();
  const release = acquireVaultOwnership(request.database);
  await vaultRestoreMaintenance(request);
  expect(() => acquireVaultOwnership(request.database)).toThrow(/maintenance is active/);
  await expect(vaultRestoreMaintenance({ ...request, action: "replace" }, { account })).rejects.toMatchObject({ code: "SQLITE_BUSY" });
  const marker = readFileSync(`${request.database}.maintenance`);
  await expect(vaultRestoreMaintenance(request)).rejects.toMatchObject({ code: "EEXIST" });
  expect(readFileSync(`${request.database}.maintenance`)).toEqual(marker);
  release(); await vaultRestoreMaintenance({ ...request, action: "release" });
});

it("fails closed for an older runtime", async () => {
  const request = fixture(); rmSync(`${request.database}.owner-lock`); writeFileSync(request.database, "older");
  await expect(vaultRestoreMaintenance(request)).rejects.toThrow(/runtime lacks its ownership lock/);
  expect(readdirSync(join(request.database, ".."))).toEqual(expect.arrayContaining(["vault.db"]));
});

it("runs the bundled privileged payload standalone without logging plaintext or source paths", async () => {
  const request = fixture(), output = join(request.database, "..", "maintenance.mjs");
  await build({ entryPoints: [new URL("./vault-restore-maintenance.ts", import.meta.url).pathname], outfile: output, bundle: true, packages: "external", platform: "node", format: "esm" });
  // Import with real Node, not Vitest's transformed module loader: serialization
  // must use the exact built function, without Vite's dynamic-import shims.
  const script = `import {vaultRestoreMaintenance as run} from ${JSON.stringify(pathToFileURL(output).href)};import {spawnSync} from 'node:child_process';const payload='('+run.toString()+')(JSON.parse(process.argv[1])).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});';const child=spawnSync(process.execPath,['--input-type=module','-e',payload,process.argv[1]],{encoding:'utf8',env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}});process.stdout.write(child.stdout);process.stderr.write(child.stderr);process.exitCode=child.status??1;`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(request)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("{}");
  expect(result.stdout + result.stderr).not.toContain(request.snapshot);
  expect(result.stdout + result.stderr).not.toContain("replacement");
  await vaultRestoreMaintenance({ ...request, action: "release" });
});

it("waits for the observed managed process to exit and refuses if it remains alive", async () => {
  const request = fixture();
  await vaultRestoreMaintenance(request);
  await expect(vaultRestoreMaintenance({ ...request, action: "replace", daemonPid: process.pid }, { account })).rejects.toThrow(/process is still alive/);
  expect(existsSync(request.database)).toBe(false);
  await vaultRestoreMaintenance({ ...request, action: "release" });
});

it("independently rejects a live source alias or a source with companions before creating its maintenance marker", async () => {
  const request = fixture();
  await expect(vaultRestoreMaintenance({ ...request, database: request.snapshot!, snapshot: request.snapshot })).rejects.toThrow(/source is the live vault/);
  writeFileSync(`${request.snapshot}-wal`, "must preserve");
  const before = readFileSync(request.snapshot!);
  await expect(vaultRestoreMaintenance(request)).rejects.toThrow(/sealed single-file/);
  expect(readFileSync(request.snapshot!)).toEqual(before);
  expect(readFileSync(`${request.snapshot}-wal`, "utf8")).toBe("must preserve");
  expect(existsSync(`${request.database}.maintenance`)).toBe(false);
});
