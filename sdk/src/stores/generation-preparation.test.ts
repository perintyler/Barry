import { SqliteDatabase as DatabaseSync } from "./sqlite-connection.js";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { activateStoreGeneration } from "./generation-activation.js";
import { prepareStoreGeneration, validatePreparedStoreGeneration } from "./generation-preparation.js";
import { activeStoreRoot } from "./migration.js";

const directories: string[] = [];
const connections: DatabaseSync[] = [];
const readOnlyDirectories: string[] = [];
afterEach(() => {
  for (const database of connections.splice(0)) database.close();
  for (const directory of readOnlyDirectories.splice(0)) chmodSync(directory, 0o700);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "barry-generation-preparation-")); directories.push(root);
  const previous = join(root, "generations/previous"), filepath = join(previous, "node/todos/default.db");
  mkdirSync(dirname(filepath), { recursive: true });
  const writer = new DatabaseSync(filepath); connections.push(writer);
  writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE todos(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO todos VALUES(1,'committed WAL row'); CREATE TABLE events(value TEXT); INSERT INTO events(rowid,value) VALUES(7,'seven'),(42,'fortytwo')");
  const memoryPath = join(previous, "identities/alice/memory/default.db"); mkdirSync(dirname(memoryPath), { recursive: true });
  const memory = new DatabaseSync(memoryPath);
  memory.exec("CREATE TABLE memory(owner TEXT,value TEXT); INSERT INTO memory VALUES('alice','permanent memory')"); memory.close();
  mkdirSync(join(previous, "unknown/empty"), { recursive: true }); chmodSync(join(previous, "unknown/empty"), 0o750);
  writeFileSync(join(previous, "unknown/bytes.bin"), Buffer.from([0, 255, 13, 0, 128])); chmodSync(join(previous, "unknown/bytes.bin"), 0o640);
  writeFileSync(join(previous, "prepared.json"), "unrelated user file");
  const captured = new DatabaseSync(join(previous, "unknown/capture.db"));
  captured.exec("CREATE TABLE captured(value TEXT); INSERT INTO captured VALUES('immutable capture')"); captured.close();
  writeFileSync(join(root, "active.json"), JSON.stringify({ id: "previous", provenance: "preserved" }));
  return { root, previous, writer, filepath };
}
it("captures WAL stores and preserves other stores, binary files, empty directories, modes and immutable snapshots", async () => {
  const source = fixture(), selector = readFileSync(join(source.root, "active.json"));
  const prepared = await prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: true });
  expect(prepared.state).toBe("prepared"); expect(activeStoreRoot(source.root)).toBe(source.previous);
  expect(readFileSync(join(source.root, "active.json"))).toEqual(selector);
  expect(await validatePreparedStoreGeneration(source.root, prepared.id)).toEqual(prepared);
  const todos = new DatabaseSync(join(prepared.directory, "node/todos/default.db"), { readOnly: true }), memory = new DatabaseSync(join(prepared.directory, "identities/alice/memory/default.db"), { readOnly: true });
  try {
    expect(todos.prepare("SELECT * FROM todos").all()).toEqual([{ id: 1, value: "committed WAL row" }]);
    expect(todos.prepare("SELECT rowid,value FROM events").all()).toEqual([{ rowid: 7, value: "seven" }, { rowid: 42, value: "fortytwo" }]);
    expect(memory.prepare("SELECT * FROM memory").all()).toEqual([{ owner: "alice", value: "permanent memory" }]);
  } finally { todos.close(); memory.close(); }
  expect(await validatePreparedStoreGeneration(source.root, prepared.id)).toEqual(prepared);
  expect(existsSync(join(prepared.directory, "node/todos/default.db-wal"))).toBe(false);
  for (const path of ["unknown/bytes.bin", "unknown/capture.db", "prepared.json"]) {
    expect(readFileSync(join(prepared.directory, path))).toEqual(readFileSync(join(source.previous, path)));
    expect(lstatSync(join(prepared.directory, path)).ino).not.toBe(lstatSync(join(source.previous, path)).ino);
  }
  expect(lstatSync(join(prepared.directory, "unknown/bytes.bin")).mode & 0o777).toBe(0o640);
  expect(lstatSync(join(prepared.directory, "unknown/empty")).mode & 0o777).toBe(0o750);
  source.writer.exec("INSERT INTO todos VALUES(2,'later source row')");
  expect(await validatePreparedStoreGeneration(source.root, prepared.id)).toEqual(prepared);
});
it("completes native backup in an otherwise idle worker without waiting for an unrelated timer", async () => {
  const source = fixture(), module = new URL("../../dist/stores/generation-preparation.js", import.meta.url).href;
  const worker = new Worker(`
    const {parentPort}=require('node:worker_threads');
    import(${JSON.stringify(module)}).then(async ({prepareStoreGeneration}) => {
      const prepared=await prepareStoreGeneration({root:${JSON.stringify(source.root)},previousId:'previous',servicesStopped:true});
      parentPort.postMessage(prepared.id);
    }).catch(error=>{throw error;});
  `, { eval: true, execArgv: [] });
  try {
    const id = await new Promise<string>((resolve, reject) => {
      // This verifies acknowledgement from an otherwise idle worker, not a
      // two-second host I/O benchmark. Early exit still rejects immediately.
      const deadline = setTimeout(() => reject(new Error("native worker backup did not complete within its bounded watchdog")), 10_000);
      worker.once("message", id => { clearTimeout(deadline); resolve(id as string); });
      worker.once("error", error => { clearTimeout(deadline); reject(error); });
      worker.once("exit", code => { clearTimeout(deadline); reject(new Error(`backup worker exited before acknowledgement: ${code}`)); });
    });
    expect((await validatePreparedStoreGeneration(source.root, id)).state).toBe("prepared");
    expect(activeStoreRoot(source.root)).toBe(source.previous);
  } finally { await worker.terminate(); }
}, 30_000);
it("records build transformations while retaining untouched source stores and files", async () => {
  const source = fixture();
  const prepared = await prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: true,
    async build(directory) {
      const database = new DatabaseSync(join(directory, "node/todos/default.db"));
      try { database.exec("UPDATE todos SET value='restored backup row'"); } finally { database.close(); }
      writeFileSync(join(directory, "new-deliverable.txt"), "restored");
    },
  });
  expect(await validatePreparedStoreGeneration(source.root, prepared.id)).toEqual(prepared);
  expect(source.writer.prepare("SELECT value FROM todos").get()?.value).toBe("committed WAL row");
  expect(readFileSync(join(prepared.directory, "new-deliverable.txt"), "utf8")).toBe("restored");
});
it("normalizes newly built WAL catalogs and keeps complete receipts valid through real read-only activation checks", async () => {
  const source = fixture();
  const prepared = await prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: true,
    async build(directory) {
      const path = join(directory, "identities/alice/restored/default.db"); mkdirSync(dirname(path), { recursive: true });
      const database = new DatabaseSync(path);
      try { database.exec("PRAGMA journal_mode=WAL; CREATE TABLE restored(value TEXT); INSERT INTO restored VALUES('backup row')"); } finally { database.close(); }
      chmodSync(path, 0o400); chmodSync(dirname(path), 0o500); readOnlyDirectories.push(dirname(path));
    },
  });
  const validate = async (directory: string) => {
    for (const path of ["node/todos/default.db", "identities/alice/restored/default.db"]) {
      const database = new DatabaseSync(join(directory, path), { readOnly: true });
      try {
        expect(database.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
        expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      } finally { database.close(); }
      expect(existsSync(join(directory, `${path}-wal`))).toBe(false);
      expect(existsSync(join(directory, `${path}-shm`))).toBe(false);
    }
    expect(await validatePreparedStoreGeneration(source.root, prepared.id)).toEqual(prepared);
  };
  await validate(prepared.directory);
  expect(lstatSync(join(prepared.directory, "identities/alice/restored/default.db")).mode & 0o777).toBe(0o400);
  expect(lstatSync(join(prepared.directory, "identities/alice/restored")).mode & 0o777).toBe(0o500);
  expect((await activateStoreGeneration({ root: source.root, id: prepared.id, previousId: "previous", servicesStopped: true, validate,
    sealPrevious: async () => { source.writer.exec("CREATE TRIGGER sealed_todos BEFORE INSERT ON todos BEGIN SELECT RAISE(ABORT,'sealed history'); END;"); },
  })).state).toBe("active");
  expect(() => source.writer.exec("INSERT INTO todos VALUES(2,'late')")).toThrow(/sealed history/);
  expect(await validatePreparedStoreGeneration(source.root, prepared.id)).toEqual(prepared);
});
it("refuses private WAL catalogs with an undrained handle or invalid foreign keys", async () => {
  const source = fixture();
  await expect(prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: true, build: async directory => {
    const database = new DatabaseSync(join(directory, "node/todos/default.db")); connections.push(database);
    database.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; INSERT INTO todos VALUES(2,'uncommitted')");
  } })).rejects.toThrow();
  await expect(prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: true, build: async directory => {
    const database = new DatabaseSync(join(directory, "node/todos/default.db"));
    try { database.exec("PRAGMA foreign_keys=OFF; CREATE TABLE missing(id INTEGER PRIMARY KEY); CREATE TABLE broken(id INTEGER REFERENCES missing(id)); INSERT INTO broken VALUES(42)"); } finally { database.close(); }
  } })).rejects.toThrow(/invalid private store database/);
  expect(activeStoreRoot(source.root)).toBe(source.previous);
  expect(source.writer.prepare("SELECT count(*) AS count FROM todos").get()?.count).toBe(1);
});
it("refuses source or selector changes, unsafe entries and entry limits without activating or deleting history", async () => {
  const source = fixture();
  await expect(prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: false })).rejects.toThrow(/stop/);
  await expect(prepareStoreGeneration({ root: source.root, previousId: "wrong", servicesStopped: true })).rejects.toThrow(/no longer selected/);
  await expect(prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: true, maximumEntries: 1 })).rejects.toThrow(/limit/);
  await expect(prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: true, build: async () => {
    writeFileSync(join(source.previous, "unknown/bytes.bin"), "changed source");
  } })).rejects.toThrow(/source generation changed/);
  await expect(prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: true, build: async () => {
    writeFileSync(join(source.root, "active.json"), JSON.stringify({ id: "other-selection" }));
  } })).rejects.toThrow(/selector changed/);
  writeFileSync(join(source.root, "active.json"), JSON.stringify({ id: "previous" }));
  symlinkSync(join(source.previous, "unknown/bytes.bin"), join(source.previous, "unknown/alias"));
  await expect(prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: true })).rejects.toThrow(/unsupported/);
  expect(activeStoreRoot(source.root)).toBe(source.previous);
  expect(source.writer.prepare("SELECT value FROM todos").get()?.value).toBe("committed WAL row");
  for (const file of readdirSync(join(source.root, "preparations"))) {
    if (!file.startsWith(".")) expect(JSON.parse(readFileSync(join(source.root, "preparations", file), "utf8")).state).toBe("failed");
  }
});
it("detects candidate content, mode, inventory and symlink substitutions", async () => {
  const source = fixture(), prepared = await prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: true });
  const path = join(prepared.directory, "unknown/bytes.bin"), bytes = readFileSync(path);
  writeFileSync(path, "substituted"); await expect(validatePreparedStoreGeneration(source.root, prepared.id)).rejects.toThrow(/changed/);
  writeFileSync(path, bytes); chmodSync(path, 0o600); await expect(validatePreparedStoreGeneration(source.root, prepared.id)).rejects.toThrow(/changed/);
  chmodSync(path, 0o640); writeFileSync(join(prepared.directory, "unexpected.txt"), "unexpected");
  await expect(validatePreparedStoreGeneration(source.root, prepared.id)).rejects.toThrow(/changed/);
  rmSync(join(prepared.directory, "unexpected.txt")); rmSync(path); symlinkSync(join(source.previous, "unknown/bytes.bin"), path);
  await expect(validatePreparedStoreGeneration(source.root, prepared.id)).rejects.toThrow(/unsupported/);
});
it.each(["preparing", "file", "build", "normalized", "prepared"])("an actual SIGKILL at %s retains history and cannot acknowledge partial preparation", async boundary => {
  const source = fixture(), module = new URL("../../dist/stores/generation-preparation.js", import.meta.url).href;
  const script = `
    import {SqliteDatabase as DatabaseSync} from ${JSON.stringify(new URL("../../dist/stores/sqlite-connection.js", import.meta.url).href)}; import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; import {join} from 'node:path';
    import {prepareStoreGeneration} from ${JSON.stringify(module)};
    const root=process.argv[1],boundary=process.argv[2],rename=fs.rename,chmod=fs.chmod;
    fs.rename=async function(from,to) {
      await rename(from,to);
      if(to.startsWith(join(root,'preparations')) && to.endsWith('.json') && JSON.parse(await fs.readFile(to,'utf8')).state===boundary) process.kill(process.pid,'SIGKILL');
    };
    fs.chmod=async function(path,mode) {await chmod(path,mode); if(boundary==='file' && path.includes('/generations/') && !path.includes('/generations/previous/')) process.kill(process.pid,'SIGKILL');};
    const prepare=DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare=function(sql) {
      const statement=prepare.call(this,sql),get=statement.get;
      if(boundary==='normalized' && sql==='PRAGMA journal_mode=DELETE') statement.get=function(...args){const result=get.apply(this,args);process.kill(process.pid,'SIGKILL');return result;};
      return statement;
    };
    syncBuiltinESMExports();
    await prepareStoreGeneration({root,previousId:'previous',servicesStopped:true,build:async()=>{if(boundary==='build') process.kill(process.pid,'SIGKILL');}});
    throw Error('crash point not reached');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script, source.root, boundary], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 10000 });
  expect(child.signal, child.stderr).toBe("SIGKILL");
  expect(activeStoreRoot(source.root)).toBe(source.previous);
  expect(source.writer.prepare("SELECT value FROM todos").get()?.value).toBe("committed WAL row");
  const receipts = readdirSync(join(source.root, "preparations")).filter(name => name.endsWith(".json")); expect(receipts).toHaveLength(1);
  const receipt = JSON.parse(readFileSync(join(source.root, "preparations", receipts[0]), "utf8"));
  if (boundary === "prepared") expect(await validatePreparedStoreGeneration(source.root, receipt.id)).toEqual(receipt);
  else await expect(validatePreparedStoreGeneration(source.root, receipt.id)).rejects.toThrow();
  expect((await prepareStoreGeneration({ root: source.root, previousId: "previous", servicesStopped: true })).state).toBe("prepared");
});

it("copies an explicit source while retaining the selected generation and recording provenance", async () => {
  const selected = fixture(), source = join(selected.root, "generations", "older");
  mkdirSync(source);
  writeFileSync(join(source, "retained.txt"), "older bytes");
  const selector = readFileSync(join(selected.root, "active.json"));
  const prepared = await prepareStoreGeneration({ root: selected.root, previousId: "previous", source: "older", servicesStopped: true,
    async build(_candidate, previous) { expect(previous).toBe(source); },
  });
  expect(prepared.source).toBe("older");
  expect(readFileSync(join(prepared.directory, "retained.txt"), "utf8")).toBe("older bytes");
  expect(readFileSync(join(source, "retained.txt"), "utf8")).toBe("older bytes");
  expect(selected.writer.prepare("SELECT value FROM todos").get()?.value).toBe("committed WAL row");
  expect(readFileSync(join(selected.root, "active.json"))).toEqual(selector);
  expect(await validatePreparedStoreGeneration(selected.root, prepared.id)).toEqual(prepared);
  const normal = await prepareStoreGeneration({ root: selected.root, previousId: "previous", servicesStopped: true });
  expect(normal).not.toHaveProperty("source");
});
it("refuses missing, symlinked, invalid or candidate sources", async () => {
  const { root, previous } = fixture();
  const base = { root, previousId: "previous", servicesStopped: true };
  await expect(prepareStoreGeneration({ ...base, source: "missing" })).rejects.toThrow(/ENOENT/);
  symlinkSync(previous, join(root, "generations", "alias"));
  await expect(prepareStoreGeneration({ ...base, source: "alias" })).rejects.toThrow(/directory/);
  await expect(prepareStoreGeneration({ ...base, source: "../escape" })).rejects.toThrow();
  await expect(prepareStoreGeneration({ ...base, source: "candidate", id: "candidate" })).rejects.toThrow(/source generation/);
  await expect(prepareStoreGeneration({ ...base, source: "previous", id: "failed-source", build: async () => { throw Error("failed build"); } })).rejects.toThrow(/failed build/);
  expect(JSON.parse(readFileSync(join(root, "preparations/failed-source.json"), "utf8"))).not.toHaveProperty("source");
});

it("records the explicit source while preparing and after failure, and rejects source changes", async () => {
  const { root } = fixture(), source = join(root, "generations", "older");
  mkdirSync(source); writeFileSync(join(source, "value.txt"), "original");
  await expect(prepareStoreGeneration({ root, previousId: "previous", source: "older", id: "changed-source", servicesStopped: true,
    async build() {
      expect(JSON.parse(readFileSync(join(root, "preparations/changed-source.json"), "utf8"))).toMatchObject({ state: "preparing", source: "older" });
      writeFileSync(join(source, "value.txt"), "changed");
    },
  })).rejects.toThrow(/source generation changed/);
  expect(JSON.parse(readFileSync(join(root, "preparations/changed-source.json"), "utf8"))).toMatchObject({ state: "failed", source: "older" });
});
