import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "barry-artifacts-package-"));
const run = (command, args, cwd = scratch) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
try {
  run("pnpm", ["--dir", join(root, "sdk"), "pack", "--pack-destination", scratch], root);
  const sdk = JSON.parse(readFileSync(join(root, "sdk/package.json"), "utf8"));
  const sdkTarball = join(scratch, `${sdk.name.replace(/^@/, "").replace("/", "-")}-${sdk.version}.tgz`);
  const source = JSON.parse(readFileSync(join(root, "bags/artifacts/package.json"), "utf8"));
  run("pnpm", ["--dir", join(root, "bags/artifacts"), "pack", "--pack-destination", scratch], root);
  const tarball = join(scratch, `${source.name.replace(/^@/, "").replace("/", "-")}-${source.version}.tgz`);
  const contents = run("tar", ["-tzf", tarball]).trim().split("\n");
  assert.equal(contents.filter(file => file === "package/LICENSE.md").length, 1);
  assert.equal(run("tar", ["-xOzf", tarball, "package/LICENSE.md"]), readFileSync(join(root, "LICENSE.md"), "utf8"));
  assert.ok(contents.includes("package/migrations/artifacts/001_initial.sql"));
  assert.ok(contents.includes("package/migrations/artifacts/002_creation.sql"));
  assert.ok(contents.includes("package/migrations/artifacts/003_maintenance.sql"));
  assert.ok(contents.includes("package/migrations/artifacts/004_registry.sql"));
  assert.ok(contents.includes("package/migrations/artifacts/005_generation.sql"));
  assert.ok(contents.includes("package/migrations/artifacts/006_shares.sql"));
  assert.ok(contents.includes("package/dist/local/restore-adapter.js"));
  assert.ok(contents.every(file => !/(?:\/src\/|\.test\.|node_modules\/|\.env$)/.test(file)));
  for (const target of Object.values(source.exports).flatMap(entry => [entry.types, entry.import])) {
    assert.ok(contents.includes(`package/${target.slice(2)}`), `Missing packed export ${target}`);
  }
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "artifact-consumer", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", sdkTarball, tarball, `typescript@${source.devDependencies.typescript}`, `@types/node@${source.devDependencies["@types/node"]}`]);
  writeFileSync(join(scratch, "consumer.ts"), `
import Database from 'better-sqlite3';
import { withArtifactStore, openLocalArtifactStore } from '@barry-rocks/artifacts-bag';
import { StoreRegistry, loadDeclaredStores, validateSnapshot, createBackup } from '@barry-rocks/sdk/internal/stores';
import { parseManifest } from '@barry-rocks/sdk/bags';
import { fileURLToPath } from 'node:url';
import { withStoreContext } from '@barry-rocks/sdk/internal/stores';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactCreator } from '@barry-rocks/artifacts-bag/create';
import { createLocalArtifactBlobs } from '@barry-rocks/artifacts-bag/local/blobs';
import { createLocalArtifactMaintenance } from '@barry-rocks/artifacts-bag/local/maintenance';
import { activateLocalArtifactRestore, prepareLocalArtifactRestore } from '@barry-rocks/artifacts-bag/local/restore';
import { ArtifactRecordSchema, type ArtifactRecord } from '@barry-rocks/artifacts-bag/types';
import { createArtifactCore } from '@barry-rocks/artifacts-bag/core';
import { createSqliteArtifactRepository, sealArtifactGeneration } from '@barry-rocks/artifacts-bag/local/catalog';
const directory = mkdtempSync(join(tmpdir(),'artifact-installed-'));
const filepath = join(directory,'catalog.db');
const db = new Database(filepath);
const repository = createSqliteArtifactRepository(db, 'packed');
const core = createArtifactCore({ repository, access: { async authorize() { return {actorId:1,identityId:'packed',credentialId:'fixture'}; } }, now: () => '2026-10-03T00:00:00.000Z' });
const page = await core.list({limit:10});
const records: readonly ArtifactRecord[] = page.items;
if (records.length) ArtifactRecordSchema.parse(records[0]);
const blobs = await createLocalArtifactBlobs(filepath);
let sequence = 0;
const creator = createArtifactCreator({repository,blobs,access:{authorize:async()=>({actorId:1,identityId:'packed',credentialId:'fixture'})},now:()=>new Date().toISOString(),newId:()=> 'packed-'+(++sequence),hashText:async text=>createHash('sha256').update(text).digest('hex')});
async function* bytes(){yield Buffer.from('installed artifact');}
const artifact = await creator.create({filename:'installed.txt',mimeType:'text/plain',kind:'text',idempotencyKey:'event'},bytes());
await blobs.verify(artifact.content);
const retry = await creator.create({filename:'installed.txt',mimeType:'text/plain',kind:'text',idempotencyKey:'event'},bytes());
if (retry.id !== artifact.id) throw new Error('retry created a duplicate');
const maintenance = createLocalArtifactMaintenance({database:db,identityId:'packed',blobs,now:()=>new Date().toISOString(),newId:()=> 'cleanup-'+(++sequence)});
const report = maintenance.run();
if(report.unavailableBlobs || report.failures.length) throw new Error('installed maintenance failed');
const generation = (db.prepare('SELECT token FROM artifact_storage_generation').get() as {token:string}).token;
sealArtifactGeneration(db,'packed',generation,new Date().toISOString());
let refused = false;
try { maintenance.run(); } catch(error) { refused = (error as {code:string}).code === 'unavailable'; }
if(!refused || (await repository.get(artifact.id))?.id !== artifact.id) throw new Error('installed sealing did not fence writes and preserve reads');
db.close();
await withStoreContext({node:'desktop',identity:'scoped',root:directory,bags:{artifacts:{stores:{default:{owned_by:'identity',engine:'sqlite',migrations:'./migrations/artifacts'}}}}},()=>withArtifactStore(async store=>{
  if(store.binding.identity !== 'scoped' || store.blobs.directory !== store.binding.filepath+'.blobs') throw new Error('wrong installed binding');
  await store.repository.list({limit:1});
  const scopedCreator = createArtifactCreator({repository:store.repository,blobs:store.blobs,access:{authorize:async()=>({actorId:1,identityId:'scoped',credentialId:'fixture'})},now:()=>new Date().toISOString(),newId:()=> 'scoped-'+(++sequence),hashText:async text=>createHash('sha256').update(text).digest('hex')});
  await scopedCreator.create({filename:'scoped.txt',mimeType:'text/plain',kind:'text',idempotencyKey:'scoped-event'},bytes());
}));
const stores = new StoreRegistry('desktop',directory);
const bagRoot = fileURLToPath(new URL('../',import.meta.resolve('@barry-rocks/artifacts-bag')));
await loadDeclaredStores(stores,[{name:'artifacts',source:{type:'local',path:bagRoot},manifest:parseManifest(bagRoot)}]);
const snapshot = await stores.snapshot({node:'desktop',identity:'scoped',bag:'artifacts',store:'default'},join(directory,'snapshots'));
await validateSnapshot(snapshot);
if(snapshot.manifest.resources?.[0].files.length !== 1) throw new Error('installed snapshot omitted artifact bytes');
await createBackup([snapshot],{root:join(directory,'backups')});
if(!stores.hasRestoreAdapter('artifacts','default')) throw new Error('installed manifest omitted restore hook');
const registryDestination=join(directory,'registry-restored.db');
await stores.prepareRestore(snapshot,registryDestination);
const registryRestored=await openLocalArtifactStore({node:'desktop',identity:'scoped',bag:'artifacts',store:'default',engine:'sqlite',owned_by:'identity',filepath:registryDestination});
try {
  const page=await registryRestored.repository.list({limit:1});
  if(page.length!==1) throw new Error('registry restore lost record');
  await registryRestored.blobs.verify(page[0].content);
} finally {registryRestored.close();}
const prepared = await prepareLocalArtifactRestore(snapshot,{node:'replacement',identity:'scoped',directory:join(directory,'restores')});
if(prepared.records !== 1 || prepared.generation === prepared.sourceGeneration) throw new Error('installed restore did not prepare a fresh generation');
const restored = await openLocalArtifactStore(prepared.binding);
try {
  const page = await restored.repository.list({limit:1});
  if(page.length !== 1) throw new Error('installed restore lost the record');
  await restored.blobs.verify(page[0].content);
} finally {restored.close();}
const target = join(directory,'configured-artifacts.db');
const binding = {...prepared.binding,filepath:target};
const outgoing = await openLocalArtifactStore(binding);
outgoing.close();
const selected = new Database(target);
const expectedGeneration = (selected.prepare('SELECT token FROM artifact_storage_generation').get() as {token:string}).token;
selected.close();
const activation = await activateLocalArtifactRestore(prepared,binding,{servicesStopped:true,expectedGeneration});
if(activation.filepath !== target || activation.state !== 'active') throw new Error('installed activation did not preserve exact configured path');
const active = await openLocalArtifactStore(binding);
try {
  const page = await active.repository.list({limit:1});
  if(page.length !== 1) throw new Error('installed activation lost record');
  await active.blobs.verify(page[0].content);
} finally {active.close();}
rmSync(directory,{recursive:true,force:true});
`);
  run("npm", ["install", "--no-audit", "--no-fund", `@types/better-sqlite3@${source.devDependencies["@types/better-sqlite3"]}`]);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "consumer.ts"]);
  run(process.execPath, ["consumer.js"]);
  writeFileSync(join(scratch, "worker.ts"), `
export { ArtifactRecordSchema } from '@barry-rocks/artifacts-bag/types';
export { createArtifactCore } from '@barry-rocks/artifacts-bag/core';
export { createArtifactCreator } from '@barry-rocks/artifacts-bag/create';
export { MAX_ARTIFACT_BYTES } from '@barry-rocks/artifacts-bag/blobs';
`);
  const { build } = await import(join(root, "sdk/node_modules/esbuild/lib/main.js"));
  const bundle = await build({ entryPoints: [join(scratch, "worker.ts")], bundle: true, platform: "browser", format: "esm", write: false, metafile: true });
  assert.ok(!Object.keys(bundle.metafile.inputs).some(path => /better-sqlite3|\/local\/|\/sdk\//.test(path)), "Worker imports must not load local/SDK adapters");
  console.log("Artifacts packed Node consumer, declarations, migrations and browser/Worker imports OK.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
