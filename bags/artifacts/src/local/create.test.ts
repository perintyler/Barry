import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeAll, expect, it } from "vitest";
import { createArtifactCreator } from "../create.js";
import { createSqliteArtifactRepository } from "./catalog.js";
import { createLocalArtifactBlobs } from "./blobs.js";
import type { ArtifactGrant } from "../types.js";
import type { ArtifactBlobStore } from "../blobs.js";

const databases: Database.Database[] = [], directories: string[] = [];
beforeAll(() => {
  // Crash probes run compiled Node code, including in a fresh test checkout.
  execFileSync(process.execPath, [fileURLToPath(import.meta.resolve("typescript/bin/tsc")), "--build"], { cwd: new URL("../../", import.meta.url) });
});
afterEach(async () => { for (const database of databases.splice(0)) database.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const now = () => "2026-10-03T00:00:00.000Z";
const hashText = async (text: string) => createHash("sha256").update(text).digest("hex");
async function* bytes(text = "original") { yield Buffer.from(text); }
const request = { filename: "report.txt", mimeType: "text/plain", kind: "text" as const, idempotencyKey: "publication-event-1" };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "barry-artifact-create-")); directories.push(directory);
  const filepath = join(directory, "catalog.db"), database = new Database(filepath); databases.push(database);
  const repository = createSqliteArtifactRepository(database, "owned"), blobs = await createLocalArtifactBlobs(filepath);
  let sequence = 0, grant: ArtifactGrant = { actorId: 7, identityId: "owned", credentialId: "original" };
  const options = { repository, blobs: blobs as ArtifactBlobStore, access: { async authorize() { return grant; } }, now, newId: () => `event-${++sequence}`, hashText };
  const creator = () => createArtifactCreator(options);
  return { filepath, database, repository, blobs, options, creator, grant(value: ArtifactGrant) { grant = value; },
    count: () => (database.prepare("SELECT count(*) AS count FROM artifacts").get() as { count: number }).count,
    intents: () => database.prepare("SELECT status FROM blob_intents ORDER BY id").all() as { status: string }[] };
}
it("acknowledges durable bytes, catalog and retry result together", async () => {
  const f = await fixture(), artifact = await f.creator().create(request, bytes());
  await f.blobs.verify(artifact.content);
  expect(artifact.content.creator).toEqual({ actorId: 7, identityId: "owned" });
  expect(f.count()).toBe(1); expect(f.intents()).toEqual([{ status: "complete" }]);
  expect(await readdir(join(f.blobs.directory, "staging"))).toEqual([]);
  expect(f.database.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(f.database.pragma("synchronous", { simple: true })).toBe(2);
});
it("matching retries return the original artifact despite later metadata edits", async () => {
  const f = await fixture(), first = await f.creator().create(request, bytes());
  f.repository.transaction(transaction => transaction.replaceMetadata(first.id, 1, { ...first.metadata, title: "Edited", revision: 2 }));
  const retry = await f.creator().create(request, bytes());
  expect(retry.id).toBe(first.id); expect(retry.metadata.title).toBe("Edited"); expect(f.count()).toBe(1);
});
it("conflicts on a retry with changed bytes or original metadata", async () => {
  const f = await fixture(); await f.creator().create(request, bytes());
  await expect(f.creator().create(request, bytes("different"))).rejects.toMatchObject({ code: "conflict" });
  await expect(f.creator().create({ ...request, title: "Changed" }, bytes())).rejects.toMatchObject({ code: "conflict" });
  expect(f.count()).toBe(1); expect(f.intents().filter(intent => intent.status === "failed")).toHaveLength(2);
});
it("different events preserve distinct artifact identities while deduplicating bytes", async () => {
  const f = await fixture(), first = await f.creator().create(request, bytes());
  const second = await f.creator().create({ ...request, idempotencyKey: "second" }, bytes());
  expect(second.id).not.toBe(first.id); expect(second.content.sha256).toBe(first.content.sha256); expect(f.count()).toBe(2);
});
it("failed publication never produces a catalog record", async () => {
  const f = await fixture(); f.options.blobs = { ...f.blobs, async publish() { throw new Error("disk full"); } };
  await expect(f.creator().create(request, bytes())).rejects.toThrow("disk full");
  expect(f.count()).toBe(0); expect(f.intents()).toEqual([{ status: "failed" }]);
});
it("catalog commit failure rolls back the artifact and retry key while retaining recoverable bytes", async () => {
  const f = await fixture();
  f.database.exec("CREATE TRIGGER fail_creation BEFORE INSERT ON creation_requests BEGIN SELECT RAISE(ABORT, 'catalog fault'); END;");
  await expect(f.creator().create(request, bytes())).rejects.toThrow("catalog fault"); expect(f.count()).toBe(0);
  expect(f.database.prepare("SELECT count(*) AS count FROM creation_requests").get()).toEqual({ count: 0 });
  f.database.exec("DROP TRIGGER fail_creation");
  const retried = await f.creator().create(request, bytes()); await f.blobs.verify(retried.content); expect(f.count()).toBe(1);
});
it("revocation during publication refuses the final catalog commit", async () => {
  const f = await fixture();
  f.options.blobs = { ...f.blobs, async publish(id, blob, signal) { await f.blobs.publish(id, blob, signal); f.grant({ actorId: 7, identityId: "owned", credentialId: "replacement" }); } };
  await expect(f.creator().create(request, bytes())).rejects.toMatchObject({ code: "forbidden" });
  expect(f.count()).toBe(0); expect(f.intents()).toEqual([{ status: "failed" }]);
});
it("refuses foreign identity or unverified originating sessions before uploading", async () => {
  const f = await fixture(); f.grant({ actorId: 7, identityId: "foreign", credentialId: "original" });
  await expect(f.creator().create(request, bytes())).rejects.toMatchObject({ code: "forbidden" });
  f.grant({ actorId: 7, identityId: "owned", credentialId: "original" });
  await expect(f.creator().create({ ...request, sessionId: "unverified" }, bytes())).rejects.toMatchObject({ code: "forbidden" });
  expect(f.count()).toBe(0); expect(f.intents()).toEqual([]);
});
it("expired upload leases cannot produce a successful artifact", async () => {
  const f = await fixture(); let clock = now(); f.options.now = () => clock;
  f.options.blobs = { ...f.blobs, async publish(id, blob, signal) { await f.blobs.publish(id, blob, signal); clock = "2026-10-03T00:03:00.000Z"; } };
  await expect(f.creator().create(request, bytes())).rejects.toMatchObject({ code: "unavailable" }); expect(f.count()).toBe(0);
});
it("a failed cleanup does not turn a committed creation into a failed acknowledgment", async () => {
  const f = await fixture(); f.options.blobs = { ...f.blobs, async discard() { throw new Error("cleanup fault"); } };
  const artifact = await f.creator().create(request, bytes()); await f.blobs.verify(artifact.content);
  expect(f.intents()).toEqual([{ status: "complete" }]); expect(await readdir(join(f.blobs.directory, "staging"))).toHaveLength(1);
});
it("an intent ID collision does not fail or discard another upload", async () => {
  const f = await fixture(); f.options.newId = () => "existing";
  f.repository.beginIntent({ id: "existing", createdAt: now(), expiresAt: "2026-10-03T00:02:00.000Z" });
  await f.blobs.stage("existing", bytes("keep"));
  await expect(f.creator().create(request, bytes())).rejects.toThrow();
  expect(f.intents()).toEqual([{ status: "uploading" }]); expect(await readdir(join(f.blobs.directory, "staging"))).toEqual(["existing"]);
});
it("a cancelled uncooperative authorization returns without creating an intent", async () => {
  const f = await fixture(), controller = new AbortController();
  f.options.access.authorize = () => new Promise(() => {});
  const pending = f.creator().create(request, bytes(), controller.signal); controller.abort(new Error("stop"));
  await expect(pending).rejects.toThrow("stop"); expect(f.intents()).toEqual([]);
});
for (const boundary of ["published", "committed"]) {
  it(`survives SIGKILL after ${boundary} and safely retries`, async () => {
    const f = await fixture(), childPath = join(f.filepath, "..", "crash.mjs");
    const modules = { catalog: new URL("../../dist/local/catalog.js", import.meta.url).href, blobs: new URL("../../dist/local/blobs.js", import.meta.url).href, create: new URL("../../dist/create.js", import.meta.url).href, sqlite: import.meta.resolve("better-sqlite3") };
    await writeFile(childPath, `
import Database from ${JSON.stringify(modules.sqlite)};
import { createHash } from 'node:crypto';
import { createSqliteArtifactRepository } from ${JSON.stringify(modules.catalog)};
import { createLocalArtifactBlobs } from ${JSON.stringify(modules.blobs)};
import { createArtifactCreator } from ${JSON.stringify(modules.create)};
const database = new Database(${JSON.stringify(f.filepath)});
const repository = createSqliteArtifactRepository(database, 'owned');
const blobs = await createLocalArtifactBlobs(${JSON.stringify(f.filepath)});
const now = () => ${JSON.stringify(now())};
async function* bytes() { yield Buffer.from('original'); }
${boundary === "published" ? `
repository.beginIntent({id:'crashed',createdAt:now(),expiresAt:'2026-10-03T00:02:00.000Z'});
const blob = await blobs.stage('crashed', bytes()); repository.stageIntent('crashed',blob,now());
await blobs.publish('crashed',blob); repository.publishIntent('crashed',now());
process.kill(process.pid,'SIGKILL');
` : `
let sequence=0;
await createArtifactCreator({repository,blobs:{...blobs,discard:async()=>process.kill(process.pid,'SIGKILL')},access:{authorize:async()=>({actorId:7,identityId:'owned',credentialId:'original'})},now,newId:()=> 'child-'+(++sequence),hashText:async text=>createHash('sha256').update(text).digest('hex')}).create(${JSON.stringify(request)},bytes());
`}
`);
    const killed = spawnSync(process.execPath, [childPath], { encoding: "utf8", timeout: 10_000 });
    expect(killed.stderr).toBe(""); expect(killed.signal).toBe("SIGKILL");
    expect(f.count()).toBe(boundary === "committed" ? 1 : 0);
    const retry = await f.creator().create(request, bytes()); await f.blobs.verify(retry.content); expect(f.count()).toBe(1);
    if (boundary === "committed") expect(retry.id).toBe("child-2");
  });
}

it("two independent connections converge concurrent matching retry keys", async () => {
  const f = await fixture(), secondDatabase = new Database(f.filepath); databases.push(secondDatabase);
  const secondRepository = createSqliteArtifactRepository(secondDatabase, "owned");
  const secondBlobs = await createLocalArtifactBlobs(f.filepath); let sequence = 0;
  const second = createArtifactCreator({ ...f.options, repository: secondRepository, blobs: secondBlobs, newId: () => `second-${++sequence}` });
  const results = await Promise.all([f.creator().create(request, bytes()), second.create(request, bytes())]);
  expect(results[0].id).toBe(results[1].id); expect(f.count()).toBe(1);
  await f.blobs.verify(results[0].content);
});
it("derived artifacts require a stored parent in the same identity", async () => {
  const f = await fixture();
  await expect(f.creator().create({ ...request, derivedFrom: "missing" }, bytes())).rejects.toMatchObject({ code: "not_found" });
  expect(f.intents()).toEqual([]);
  const parent = await f.creator().create(request, bytes());
  const child = await f.creator().create({ ...request, idempotencyKey: "derived", derivedFrom: parent.id }, bytes("updated"));
  expect(child.content.derivedFrom).toBe(parent.id); expect(f.count()).toBe(2);
});
it("originating-session permission is rechecked after publication", async () => {
  const f = await fixture(); let checks = 0;
  const creator = createArtifactCreator({ ...f.options, authorizeSession: async sessionId => {
    expect(sessionId).toBe("session");
    if (++checks > 1) throw new Error("session owner changed");
  } });
  await expect(creator.create({ ...request, sessionId: "session" }, bytes())).rejects.toThrow("session owner changed");
  expect(f.count()).toBe(0); expect(f.intents()).toEqual([{ status: "failed" }]);
});

it("a failing final commit guard rolls back records and the idempotency result", async () => {
  const f = await fixture(), original = f.options.repository.commitArtifact;
  f.options.repository.commitArtifact = input => {
    let checks = 0;
    return original({ ...input, checkActive() { if (++checks === 2) throw new Error("deadline expired before commit"); } });
  };
  await expect(f.creator().create(request, bytes())).rejects.toThrow("deadline expired before commit");
  expect(f.count()).toBe(0); expect(f.database.prepare("SELECT count(*) AS count FROM creation_requests").get()).toEqual({ count: 0 });
  expect(f.intents()).toEqual([{ status: "failed" }]);
});
