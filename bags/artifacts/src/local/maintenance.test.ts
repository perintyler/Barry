import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, chmod, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeAll, expect, it } from "vitest";
import { createLocalArtifactMaintenance } from "./maintenance.js";
import { createSqliteArtifactRepository } from "./index-store.js";
import { createLocalArtifactBlobs, type LocalArtifactBlobs } from "./blobs.js";
import { createArtifactCreator } from "../create.js";

const databases: Database.Database[] = [], directories: string[] = [];
beforeAll(() => {
  execFileSync(process.execPath, [fileURLToPath(import.meta.resolve("typescript/bin/tsc")), "--build"], { cwd: new URL("../../", import.meta.url) });
});
afterEach(async () => { for (const database of databases.splice(0)) database.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function* bytes(text: string) { yield Buffer.from(text); }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "barry-artifact-maintenance-")); directories.push(directory);
  const filepath = join(directory, "catalog.db"), database = new Database(filepath); databases.push(database);
  const repository = createSqliteArtifactRepository(database, "owned"), blobs = await createLocalArtifactBlobs(filepath);
  let clock = "2026-10-03T00:00:00.000Z", sequence = 0;
  const now = () => clock, newId = () => `operation-${++sequence}`;
  const maintenance = (storage: LocalArtifactBlobs = blobs) => createLocalArtifactMaintenance({ database, identityId: "owned", blobs: storage, now, newId, budgetMs: 1000 });
  const creator = createArtifactCreator({ repository, blobs, now, newId, hashText: async text => createHash("sha256").update(text).digest("hex"), access: { async authorize() { return { actorId: 1, identityId: "owned", credentialId: "fixture" }; } } });
  const orphan = async (id: string, text: string, publish = true) => {
    repository.beginIntent({ id, createdAt: now(), expiresAt: new Date(Date.parse(now()) + 120_000).toISOString() });
    const blob = await blobs.stage(id, bytes(text)); repository.stageIntent(id, blob, now());
    if (publish) { await blobs.publish(id, blob); repository.publishIntent(id, now()); }
    return blob;
  };
  const path = (sha: string) => join(blobs.directory, "sha256", sha.slice(0, 2), sha);
  return { filepath, database, repository, blobs, creator, maintenance, orphan, path, now, newId, time(value: string) { clock = value; } };
}
it("reaps expired staging and verified orphan bytes after grace", async () => {
  const f = await fixture(), blob = await f.orphan("abandoned", "orphan"); f.time("2026-10-03T00:11:00.000Z");
  const report = f.maintenance().run(); expect(report).toMatchObject({ cleanedIntents: 1, collectedBlobs: 1, failures: [] });
  expect(await readdir(join(f.blobs.directory, "staging"))).toEqual([]);
  await expect(readFile(f.path(blob.sha256))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.database.prepare("SELECT status FROM blob_intents WHERE id = 'abandoned'").get()).toEqual({ status: "failed" });
  expect(f.database.prepare("SELECT count(*) AS count FROM blob_deletions").get()).toEqual({ count: 0 });
  expect(f.database.prepare("SELECT count(*) AS count FROM blob_gc_completed").get()).toEqual({ count: 1 });
});
it("preserves committed artifacts while cleaning their old staging intents", async () => {
  const f = await fixture(), artifact = await f.creator.create({ filename: "saved.txt", mimeType: "text/plain", kind: "text", idempotencyKey: "event" }, bytes("saved"));
  f.time("2026-10-03T00:11:00.000Z"); const report = f.maintenance().run(); expect(report.collectedBlobs).toBe(0); expect(report.protectedBlobs).toBe(1);
  await f.blobs.verify(artifact.content); expect((await f.repository.get(artifact.id))?.content).toEqual(artifact.content);
});
it("protects failed-but-still-leased uploads instead of relying on status alone", async () => {
  const f = await fixture(), blob = await f.orphan("old", "same"); f.time("2026-10-03T00:10:00.000Z");
  await f.orphan("active", "same"); f.repository.failIntent("active");
  expect(f.maintenance().run().collectedBlobs).toBe(0); await f.blobs.verify(blob);
  f.time("2026-10-03T00:21:00.000Z"); expect(f.maintenance().run().collectedBlobs).toBe(1);
});
it("backup pins survive reopening and prevent orphan collection until released", async () => {
  const f = await fixture(), blob = await f.orphan("pinned", "backup"), first = f.maintenance(); first.pin("backup-1", [blob.sha256]);
  f.time("2026-10-03T00:11:00.000Z");
  const reopened = new Database(f.filepath); databases.push(reopened);
  const restarted = createLocalArtifactMaintenance({ database: reopened, identityId: "owned", blobs: f.blobs, now: f.now, newId: f.newId, budgetMs: 1000 }); expect(restarted.run().collectedBlobs).toBe(0); await f.blobs.verify(blob);
  restarted.releasePin("backup-1"); expect(restarted.run().collectedBlobs).toBe(1);
});
it("failed physical deletion retains a durable gate and blocks new publication for that hash", async () => {
  const f = await fixture(), blob = await f.orphan("old", "retry"), storage = { ...f.blobs, removeSync() { throw new Error("disk unavailable"); } };
  f.time("2026-10-03T00:11:00.000Z"); const report = f.maintenance(storage).run(); expect(report.failures).toHaveLength(1);
  f.repository.beginIntent({ id: "new", createdAt: f.now(), expiresAt: "2026-10-03T00:13:00.000Z" });
  await f.blobs.stage("new", bytes("retry"));
  expect(() => f.repository.stageIntent("new", blob, f.now())).toThrow(/unavailable/);
  expect(() => f.maintenance().pin("new-pin", [blob.sha256])).toThrow(/unavailable/);
  expect(f.database.prepare("SELECT count(*) AS count FROM blob_deletions").get()).toEqual({ count: 1 });
});
it("resumes a deletion whose file vanished before the catalog acknowledgment", async () => {
  const f = await fixture(), blob = await f.orphan("old", "crash"); f.time("2026-10-03T00:11:00.000Z");
  f.database.prepare("INSERT INTO blob_deletions VALUES (?, ?, 'interrupted', ?)").run(blob.sha256, blob.size, f.now());
  f.blobs.removeSync(blob);
  expect(f.maintenance().run().collectedBlobs).toBe(1);
  expect(f.database.prepare("SELECT count(*) AS count FROM blob_deletions").get()).toEqual({ count: 0 });
});
it("corrupt orphan bytes are retained and reported", async () => {
  const f = await fixture(), blob = await f.orphan("bad", "original"); await chmod(f.path(blob.sha256), 0o600); await writeFile(f.path(blob.sha256), "tampered");
  f.time("2026-10-03T00:11:00.000Z"); const report = f.maintenance().run(); expect(report.collectedBlobs).toBe(0); expect(report.failures).toHaveLength(1);
  expect(await readFile(f.path(blob.sha256), "utf8")).toBe("tampered");
});
it("persists bounded scan cursors so later abandoned files are reached after restart", async () => {
  const f = await fixture(); for (let index = 0; index < 5; index++) await f.orphan(`old-${index}`, `content-${index}`);
  f.time("2026-10-03T00:11:00.000Z"); let cleaned = 0, collected = 0;
  for (let iteration = 0; iteration < 5; iteration++) {
    const report = f.maintenance().run(1); expect(report.examined).toBeLessThanOrEqual(2); cleaned += report.cleanedIntents; collected += report.collectedBlobs;
  }
  expect(cleaned).toBe(5); expect(collected).toBe(5); expect(await readdir(join(f.blobs.directory, "staging"))).toEqual([]);
});
it("refuses a different database sidecar or catalog identity", async () => {
  const first = await fixture(), second = await fixture();
  expect(() => createLocalArtifactMaintenance({ database: first.database, identityId: "owned", blobs: second.blobs, now: first.now, newId: first.newId })).toThrow(/forbidden/);
  expect(() => createLocalArtifactMaintenance({ database: first.database, identityId: "foreign", blobs: first.blobs, now: first.now, newId: first.newId })).toThrow(/forbidden/);
});
it("a database-path replacement stops cleanup before touching old blobs", async () => {
  const f = await fixture(), blob = await f.orphan("keep", "protected by generation"), maintenance = f.maintenance();
  f.time("2026-10-03T00:11:00.000Z"); await rename(f.filepath, `${f.filepath}.old`);
  const replacement = new Database(f.filepath); databases.push(replacement); createSqliteArtifactRepository(replacement, "owned");
  expect(() => maintenance.run()).toThrow(/unavailable/); expect(await readFile(f.path(blob.sha256), "utf8")).toBe("protected by generation");
});
it("an interrupted deletion can be completed before equal-content bytes are safely republished", async () => {
  const f = await fixture(), blob = await f.orphan("old", "republish"); f.time("2026-10-03T00:11:00.000Z");
  f.database.prepare("INSERT INTO blob_deletions VALUES (?, ?, 'pending', ?)").run(blob.sha256, blob.size, f.now());
  expect(f.maintenance().run().collectedBlobs).toBe(1);
  const artifact = await f.creator.create({ filename: "new.txt", mimeType: "text/plain", kind: "text", idempotencyKey: "new" }, bytes("republish"));
  expect(artifact.content.sha256).toBe(blob.sha256); await f.blobs.verify(artifact.content);
  expect(f.database.prepare("SELECT count(*) AS count FROM blob_gc_completed").get()).toEqual({ count: 0 });
});

it("reconciliation reports missing/corrupt referenced bytes without deleting metadata", async () => {
  const f = await fixture(), artifact = await f.creator.create({ filename: "saved.txt", mimeType: "text/plain", kind: "text", idempotencyKey: "event" }, bytes("saved"));
  await rm(f.path(artifact.content.sha256)); f.time("2026-10-03T00:11:00.000Z");
  const report = f.maintenance().run(); expect(report.unavailableBlobs).toBe(1); expect(report.failures).toHaveLength(1);
  expect(await f.repository.get(artifact.id)).toEqual(artifact);
});
it("replacement of the sidecar stops cleanup without touching the replacement files", async () => {
  const f = await fixture(), blob = await f.orphan("old", "keep"), maintenance = f.maintenance();
  await rename(f.blobs.directory, `${f.blobs.directory}.old`);
  const replacement = await createLocalArtifactBlobs(f.filepath);
  const newer = await replacement.stage("new", bytes("keep")); await replacement.publish("new", newer);
  f.time("2026-10-03T00:11:00.000Z"); expect(() => maintenance.run()).toThrow(/unavailable/);
  await replacement.verify(blob);
});

it("SIGKILL after physical deletion leaves a durable gate that the next worker safely completes", async () => {
  const f = await fixture(), blob = await f.orphan("crashed", "crash boundary"); f.time("2026-10-03T00:11:00.000Z");
  const childPath = join(f.filepath, "..", "cleanup-crash.mjs");
  const modules = { maintenance: new URL("../../dist/local/maintenance.js", import.meta.url).href, blobs: new URL("../../dist/local/blobs.js", import.meta.url).href, sqlite: import.meta.resolve("better-sqlite3") };
  await writeFile(childPath, `
import Database from ${JSON.stringify(modules.sqlite)};
import { createLocalArtifactMaintenance } from ${JSON.stringify(modules.maintenance)};
import { createLocalArtifactBlobs } from ${JSON.stringify(modules.blobs)};
const database=new Database(${JSON.stringify(f.filepath)}), blobs=await createLocalArtifactBlobs(${JSON.stringify(f.filepath)});
createLocalArtifactMaintenance({database,identityId:'owned',blobs:{...blobs,removeSync(blob){blobs.removeSync(blob);process.kill(process.pid,'SIGKILL');return true;}},now:()=>${JSON.stringify(f.now())},newId:()=> 'crash-ticket',budgetMs:1000}).run();
`);
  const killed = spawnSync(process.execPath, [childPath], { encoding: "utf8", timeout: 10_000 });
  expect(killed.stderr).toBe(""); expect(killed.signal).toBe("SIGKILL");
  await expect(readFile(f.path(blob.sha256))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.database.prepare("SELECT count(*) AS count FROM blob_deletions").get()).toEqual({ count: 1 });
  expect(f.database.prepare("SELECT count(*) AS count FROM blob_gc_completed").get()).toEqual({ count: 0 });
  expect(f.maintenance().run().collectedBlobs).toBe(1);
  expect(f.database.prepare("SELECT count(*) AS count FROM blob_deletions").get()).toEqual({ count: 0 });
});
it("a competing writer cannot stage the same hash while the deletion transaction holds its lock", async () => {
  const f = await fixture(), blob = await f.orphan("old", "same"); f.time("2026-10-03T00:11:00.000Z");
  f.repository.beginIntent({ id: "waiting", createdAt: f.now(), expiresAt: "2026-10-03T00:13:00.000Z" });
  const staged = await f.blobs.stage("waiting", bytes("same"));
  const childPath = join(f.filepath, "..", "competing-stage.mjs");
  await writeFile(childPath, `
import Database from ${JSON.stringify(import.meta.resolve("better-sqlite3"))};
const database=new Database(${JSON.stringify(f.filepath)},{timeout:40});
try {
  database.transaction(()=>{
    if(database.prepare('SELECT 1 FROM blob_deletions WHERE sha256=?').get(${JSON.stringify(blob.sha256)})) throw new Error('deletion pending');
    database.prepare("UPDATE blob_intents SET status='staged',sha256=?,size=? WHERE id='waiting'").run(${JSON.stringify(staged.sha256)},${staged.size});
  }).immediate();
  process.exitCode=2;
} catch(error){if(error.code !== 'SQLITE_BUSY') throw error;}
finally{database.close();}
`);
  let attempts = 0;
  const maintenance = f.maintenance({ ...f.blobs, removeSync(candidate) {
    attempts++;
    const child = spawnSync(process.execPath, [childPath], { encoding: "utf8", timeout: 2000 });
    expect(child.stderr).toBe(""); expect(child.status).toBe(0);
    return f.blobs.removeSync(candidate);
  } });
  expect(maintenance.run().collectedBlobs).toBe(1); expect(attempts).toBe(1);
  f.repository.stageIntent("waiting", staged, f.now()); await f.blobs.publish("waiting", staged); await f.blobs.verify(staged);
  // A second worker observes the new lease instead of deleting the republished bytes.
  expect(f.maintenance().run().collectedBlobs).toBe(0); await f.blobs.verify(staged);
});

it("reports verified referenced content and leaves unknown filesystem files alone", async () => {
  const f = await fixture(), artifact = await f.creator.create({ filename: "saved.txt", mimeType: "text/plain", kind: "text", idempotencyKey: "event" }, bytes("saved"));
  await writeFile(join(f.blobs.directory, "staging", "unowned"), "preserve unknown file");
  f.time("2026-10-03T00:11:00.000Z"); const report = f.maintenance().run(); expect(report.verifiedBlobs).toBe(1); expect(report.failures).toEqual([]);
  expect(await readFile(join(f.blobs.directory, "staging", "unowned"), "utf8")).toBe("preserve unknown file");
  await f.blobs.verify(artifact.content);
});
