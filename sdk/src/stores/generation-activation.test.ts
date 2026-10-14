import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { activateStoreGeneration, bootstrapStoreGeneration, previousStoreGeneration, interruptedStoreGeneration, recoverStoreGeneration, acquireStoreGenerationLock } from "./generation-activation.js";
import { activeStoreRoot, migrateLegacyStores } from "./migration.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "barry-generation-activation-")); directories.push(root);
  for (const id of ["previous", "candidate"]) {
    const directory = join(root, "generations", id); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(join(directory, "records.db"));
    database.exec(`CREATE TABLE status(state TEXT); INSERT INTO status VALUES('active');
      CREATE TABLE history(value TEXT); INSERT INTO history VALUES('${id}');
      CREATE TRIGGER sealed_history BEFORE UPDATE ON history WHEN (SELECT state FROM status)='sealed'
      BEGIN SELECT RAISE(ABORT,'sealed history'); END;`);
    database.close();
    writeFileSync(join(directory, "unknown-preserved.txt"), "retained");
  }
  writeFileSync(join(root, "active.json"), JSON.stringify({ id: "previous", provenance: "retained selector bytes" }));
  return root;
}
async function validate(directory: string): Promise<void> {
  const database = new DatabaseSync(join(directory, "records.db"), { readOnly: true });
  try {
    if (database.prepare("SELECT value FROM history").get()?.value !== "candidate") throw new Error("invalid candidate records");
    if (database.prepare("SELECT state FROM status").get()?.state !== "active") throw new Error("candidate is sealed");
  } finally { database.close(); }
  expect(readFileSync(join(directory, "unknown-preserved.txt"), "utf8")).toBe("retained");
}
async function sealPrevious(directory: string): Promise<void> {
  const database = new DatabaseSync(join(directory, "records.db"));
  try { database.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE; UPDATE status SET state='sealed' WHERE state='active'; COMMIT"); }
  finally { database.close(); }
}
const options = (root: string) => ({ root, id: "candidate", previousId: "previous", servicesStopped: true, validate, sealPrevious });
it("publishes a complete generation, fences retained history and leaves previous files intact", async () => {
  const root = fixture(), retained = new DatabaseSync(join(root, "generations/previous/records.db"));
  try {
    const journal = await activateStoreGeneration(options(root));
    expect(journal.state).toBe("active"); expect(activeStoreRoot(root)).toBe(join(root, "generations/candidate"));
    expect(await activateStoreGeneration(options(root))).toEqual(journal);
    expect(retained.prepare("SELECT value FROM history").get()?.value).toBe("previous");
    expect(() => retained.exec("UPDATE history SET value='late'")).toThrow(/sealed history/);
    expect(readFileSync(join(root, "generations/previous/unknown-preserved.txt"), "utf8")).toBe("retained");
  } finally { retained.close(); }
});
it("refuses invalid mapping, running services, invalid candidates and occupied native locks before sealing", async () => {
  const root = fixture(), before = readFileSync(join(root, "active.json"));
  await expect(activateStoreGeneration({ ...options(root), servicesStopped: false })).rejects.toThrow(/stop/);
  await expect(activateStoreGeneration({ ...options(root), id: "../escape" })).rejects.toThrow();
  await expect(activateStoreGeneration({ ...options(root), previousId: "candidate" })).rejects.toThrow(/mapping/);
  await expect(activateStoreGeneration({ ...options(root), validate: async () => { throw new Error("bad candidate"); } })).rejects.toThrow(/bad candidate/);
  const lock = new DatabaseSync(join(root, "activation.db"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    await expect(activateStoreGeneration(options(root))).rejects.toThrow(/locked/);
    await expect(migrateLegacyStores([], { servicesStopped: true, root, archives: join(root, "archives") })).rejects.toThrow(/locked/);
    lock.exec("ROLLBACK");
  } finally { lock.close(); }
  expect(readFileSync(join(root, "active.json"))).toEqual(before);
  expect((await activateStoreGeneration(options(root))).state).toBe("active");
});
it("refuses symlinked candidate directories without changing the selector", async () => {
  const root = fixture(), candidate = join(root, "generations/candidate");
  rmSync(candidate, { recursive: true }); symlinkSync(join(root, "generations/previous"), candidate);
  await expect(activateStoreGeneration(options(root))).rejects.toThrow(/directory/);
  expect(activeStoreRoot(root)).toBe(join(root, "generations/previous"));
});
it("refuses an occupied historical receipt before sealing", async () => {
  const root = fixture(), directory = join(root, "activations"); mkdirSync(directory);
  writeFileSync(join(directory, "candidate.json"), "preserve this receipt");
  await expect(activateStoreGeneration(options(root))).rejects.toThrow(/already activated/);
  expect(activeStoreRoot(root)).toBe(join(root, "generations/previous"));
  expect(readFileSync(join(directory, "candidate.json"), "utf8")).toBe("preserve this receipt");
});
it("blocks path resolution after a failed seal and requires the same activation inputs for recovery", async () => {
  const root = fixture();
  await expect(activateStoreGeneration({ ...options(root), sealPrevious: async directory => { await sealPrevious(directory); throw new Error("interrupted sealing"); } })).rejects.toThrow(/interrupted/);
  expect(() => activeStoreRoot(root)).toThrow(/requires recovery/);
  await expect(migrateLegacyStores([], { servicesStopped: true, root })).rejects.toThrow(/requires recovery/);
  await expect(activateStoreGeneration({ ...options(root), previousId: "candidate", id: "previous" })).rejects.toThrow(/requires recovery/);
  expect((await activateStoreGeneration(options(root))).state).toBe("active");
});
it("does not overwrite a selector changed during the handoff", async () => {
  const root = fixture();
  await expect(activateStoreGeneration({ ...options(root), sealPrevious: async directory => {
    await sealPrevious(directory); writeFileSync(join(root, "active.json"), JSON.stringify({ id: "external-selection" }));
  } })).rejects.toThrow(/selector changed/);
  expect(JSON.parse(readFileSync(join(root, "active.json"), "utf8"))).toEqual({ id: "external-selection" });
  expect(() => activeStoreRoot(root)).toThrow(/requires recovery/);
});
it("revalidates the candidate after sealing and leaves a failed publication recoverable", async () => {
  const root = fixture();
  await expect(activateStoreGeneration({ ...options(root), sealPrevious: async directory => {
    await sealPrevious(directory);
    const candidate = new DatabaseSync(join(root, "generations/candidate/records.db"));
    try { candidate.exec("UPDATE history SET value='corrupted'"); } finally { candidate.close(); }
  } })).rejects.toThrow(/invalid candidate/);
  expect(JSON.parse(readFileSync(join(root, "active.json"), "utf8")).id).toBe("previous");
  expect(() => activeStoreRoot(root)).toThrow(/requires recovery/);
  const repaired = new DatabaseSync(join(root, "generations/candidate/records.db"));
  try { repaired.exec("UPDATE history SET value='candidate'"); } finally { repaired.close(); }
  expect((await activateStoreGeneration(options(root))).state).toBe("active");
});
it("retains the receipts and historical data of successive cutovers", async () => {
  const root = fixture(), first = await activateStoreGeneration(options(root));
  const next = join(root, "generations/next"); mkdirSync(next);
  for (const file of ["records.db", "unknown-preserved.txt"]) copyFileSync(join(root, "generations/candidate", file), join(next, file));
  const second = await activateStoreGeneration({ ...options(root), id: "next", previousId: "candidate" });
  expect(activeStoreRoot(root)).toBe(next);
  expect(JSON.parse(readFileSync(join(root, "activations/candidate.json"), "utf8"))).toEqual(first);
  expect(JSON.parse(readFileSync(join(root, "activations/next.json"), "utf8"))).toEqual(second);
  await expect(activateStoreGeneration(options(root))).rejects.toThrow(/outgoing generation/);
});
function killActivation(root: string, boundary: string): void {
  const module = new URL("../../dist/stores/generation-activation.js", import.meta.url).href;
  const script = `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {DatabaseSync} from 'node:sqlite'; import {join} from 'node:path';
    import {activateStoreGeneration} from ${JSON.stringify(module)};
    const root=process.argv[1],boundary=process.argv[2],rename=fs.renameSync;
    fs.renameSync=function(from,to) {
      rename(from,to);
      if(to===join(root,'active.json') && boundary==='selector') process.kill(process.pid,'SIGKILL');
      if(to===join(root,'activations/candidate.json') && boundary==='receipt') process.kill(process.pid,'SIGKILL');
      if(to===join(root,'activation.json') && JSON.parse(fs.readFileSync(to,'utf8')).state===boundary) process.kill(process.pid,'SIGKILL');
    }; syncBuiltinESMExports();
    await activateStoreGeneration({root,id:'candidate',previousId:'previous',servicesStopped:true,
      validate:async directory=>{const db=new DatabaseSync(join(directory,'records.db'),{readOnly:true}); try {if(db.prepare('SELECT value FROM history').get().value!=='candidate') throw Error('invalid candidate');}finally{db.close();}},
      sealPrevious:async directory=>{const db=new DatabaseSync(join(directory,'records.db')); try{db.exec("PRAGMA synchronous=FULL; UPDATE status SET state='sealed' WHERE state='active'");}finally{db.close();} if(boundary==='sql-seal') process.kill(process.pid,'SIGKILL');}
    }); throw Error('crash point not reached');
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script, root, boundary], { cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 10000 });
  expect(child.signal, child.stderr).toBe("SIGKILL");
}
it.each(["prepared", "sealing", "sql-seal", "sealed", "selector", "receipt", "active"])("recovers after an actual native SIGKILL at %s", async boundary => {
  const root = fixture();
  killActivation(root, boundary);
  const journal = JSON.parse(readFileSync(join(root, "activation.json"), "utf8"));
  if (journal.state !== "active") expect(() => activeStoreRoot(root)).toThrow(/requires recovery/);
  const recovered = await recoverStoreGeneration({ root, servicesStopped: true, validate });
  expect(recovered?.state).toBe(journal.state === "active" ? undefined : "active");
  expect(await recoverStoreGeneration({ root, servicesStopped: true, validate })).toBeUndefined();
  expect(activeStoreRoot(root)).toBe(join(root, "generations/candidate"));
  const previous = new DatabaseSync(join(root, "generations/previous/records.db"));
  try {
    expect(previous.prepare("SELECT value FROM history").get()?.value).toBe("previous");
    if (boundary === "prepared" || boundary === "sealing") expect(() => previous.exec("UPDATE history SET value='late'")).not.toThrow();
    else expect(() => previous.exec("UPDATE history SET value='late'")).toThrow(/sealed history/);
  } finally { previous.close(); }
});

it("bootstraps an empty fresh generation once", () => {
  const root = join(mkdtempSync(join(tmpdir(), "barry-bootstrap-")), "stores"); directories.push(join(root, ".."));
  const id = bootstrapStoreGeneration(root);
  expect(activeStoreRoot(root)).toBe(join(root, "generations", id));
  expect(bootstrapStoreGeneration(root)).toBe(id);
});
it("records a failed cutover and restores the writable previous selector", async () => {
  const root = fixture(), before = readFileSync(join(root, "active.json"));
  let validations = 0;
  await expect(activateStoreGeneration({ ...options(root), rollbackOnFailure: true,
    validate: async () => { if (++validations === 2) throw new Error("late validation failure"); },
    sealPrevious: async () => {},
  })).rejects.toThrow(/late validation/);
  expect(readFileSync(join(root, "active.json"))).toEqual(before);
  expect(activeStoreRoot(root)).toBe(join(root, "generations/previous"));
  expect(JSON.parse(readFileSync(join(root, "activations/candidate.json"), "utf8")).state).toBe("rolledBack");
});

it("finds the previous generation from the active receipt, including after a failed later activation", async () => {
  const root = fixture();
  expect(previousStoreGeneration(root)).toBeUndefined();
  await activateStoreGeneration({ ...options(root), sealPrevious: async () => {} });
  const previous = previousStoreGeneration(root)!;
  expect(previous).toMatchObject({ id: "previous", replacedBy: "candidate" });
  expect(previous.replacedAt).toBeInstanceOf(Date);
  mkdirSync(join(root, "generations", "failed"));
  await expect(activateStoreGeneration({ ...options(root), id: "failed", previousId: "candidate", rollbackOnFailure: true,
    validate: async () => { throw Error("bad candidate"); }, sealPrevious: async () => {},
  })).rejects.toThrow(/bad candidate/);
  expect(previousStoreGeneration(root)).toEqual(previous);
  rmSync(join(root, "generations", "previous"), { recursive: true });
  expect(() => previousStoreGeneration(root)).toThrow(/ENOENT/);
});
it("returns no previous generation without a selector and blocks unfinished activations", async () => {
  const root = fixture();
  rmSync(join(root, "active.json"));
  expect(previousStoreGeneration(root)).toBeUndefined();
  writeFileSync(join(root, "active.json"), JSON.stringify({ id: "previous", generation: "legacy", report: {} }));
  expect(previousStoreGeneration(root)).toBeUndefined();
  await expect(activateStoreGeneration({ ...options(root), sealPrevious: async () => { throw Error("interrupted"); } })).rejects.toThrow(/interrupted/);
  expect(() => previousStoreGeneration(root)).toThrow(/requires recovery/);
});
it.each(["id", "root", "state"])("refuses an active receipt with an invalid %s", async field => {
  const root = fixture();
  await activateStoreGeneration(options(root));
  const path = join(root, "activations/candidate.json"), receipt = JSON.parse(readFileSync(path, "utf8"));
  receipt[field] = field === "state" ? "rolledBack" : "other";
  writeFileSync(path, JSON.stringify(receipt));
  expect(() => previousStoreGeneration(root)).toThrow(/receipt/);
});
it("refuses a symlinked previous directory", async () => {
  const root = fixture();
  await activateStoreGeneration(options(root));
  const previous = join(root, "generations/previous");
  rmSync(previous, { recursive: true }); symlinkSync(join(root, "generations/candidate"), previous);
  expect(() => previousStoreGeneration(root)).toThrow(/directory/);
});
it("records rolledBack when a writable cutover fails its first validation", async () => {
  const root = fixture(), selector = readFileSync(join(root, "active.json"));
  await expect(activateStoreGeneration({ ...options(root), rollbackOnFailure: true,
    validate: async () => { throw Error("invalid prepared candidate"); }, sealPrevious: async () => {},
  })).rejects.toThrow(/invalid prepared candidate/);
  expect(readFileSync(join(root, "active.json"))).toEqual(selector);
  expect(JSON.parse(readFileSync(join(root, "activations/candidate.json"), "utf8")).state).toBe("rolledBack");
  expect(previousStoreGeneration(root)).toBeUndefined();
});
it("validates a writable candidate once before sealing and once before publication", async () => {
  const root = fixture();
  let validations = 0;
  await activateStoreGeneration({ ...options(root), rollbackOnFailure: true, sealPrevious: async () => {},
    validate: async directory => { validations++; await validate(directory); },
  });
  // Each validation re-hashes the whole candidate while the services are stopped.
  expect(validations).toBe(2);
});

it("rolls back an interrupted candidate that changed before selection", async () => {
  const root = fixture(), before = readFileSync(join(root, "active.json"));
  killActivation(root, "prepared");
  const result = await recoverStoreGeneration({ root, servicesStopped: true, validate: async () => { throw Error("changed candidate"); } });
  expect(result).toEqual({ id: "candidate", previousId: "previous", state: "rolledBack", reason: "changed candidate" });
  expect(readFileSync(join(root, "active.json"))).toEqual(before);
  expect(await recoverStoreGeneration({ root, servicesStopped: true, validate })).toBeUndefined();
});
it("refuses recovery while another process holds the operator lock", async () => {
  const root = fixture(); killActivation(root, "prepared");
  const before = readFileSync(join(root, "activation.json")), release = acquireStoreGenerationLock(root);
  try {
    expect(() => interruptedStoreGeneration(root)).toThrow("Another Barry process is switching store generations; wait for it to finish.");
    await expect(recoverStoreGeneration({ root, servicesStopped: true, validate })).rejects.toThrow(/Another Barry process/);
    expect(readFileSync(join(root, "activation.json"))).toEqual(before);
    expect(() => activeStoreRoot(root)).toThrow(/barry db recover/);
  } finally { release(); }
});
it("leaves a selected candidate unchanged when it cannot be recovered", async () => {
  const root = fixture(); killActivation(root, "selector");
  const before = readFileSync(join(root, "active.json"));
  await expect(recoverStoreGeneration({ root, servicesStopped: true, validate: async () => { throw Error("candidate changed"); } }))
    .rejects.toThrow("Cannot recover the switch to candidate: it is already selected, but candidate changed. Nothing was changed.");
  expect(readFileSync(join(root, "active.json"))).toEqual(before);
});
it("has nothing to recover in a fresh home", async () => {
  const root = fixture();
  expect(interruptedStoreGeneration(root)).toBeUndefined();
  expect(await recoverStoreGeneration({ root, servicesStopped: true, validate })).toBeUndefined();
});
