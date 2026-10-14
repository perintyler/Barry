import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const stableEntries = [
  ".", "./testing", "./tools", "./bags", "./services", "./services/http", "./stores",
  "./logging", "./logging/edge", "./auth", "./apps", "./events", "./transcripts",
  "./ids", "./http", "./acp", "./mcp", "./bounds", "./sessions",
  "./adapters/harnesses", "./adapters/models", "./openapi.json",
];
const internalEntries = [
  "actions", "adapters", "auth", "bags", "client", "env", "hooks", "identities",
  "instructions", "jobs", "mcp", "nodes", "routes", "schedules", "services",
  "sessions", "stores", "tools", "traits", "vault", "workflows",
].map(subject => `./internal/${subject}`);
const sideEffects = [
  "./dist/workflows/executor-child.js",
  "./dist/workflows/recovery-child.js", "./dist/workflows/maintenance-cli.js",
];
const scratch = mkdtempSync(join(tmpdir(), "barry-sdk-package-"));
function run(command, args, cwd = scratch, environment = process.env) {
  return execFileSync(command, args, { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
try {
  run("pnpm", ["--dir", join(root, "sdk"), "pack", "--pack-destination", scratch], root);
  const source = JSON.parse(readFileSync(join(root, "sdk/package.json"), "utf8"));
  const tarball = join(scratch, `${source.name.replace(/^@/, "").replace("/", "-")}-${source.version}.tgz`);
  const contents = run("tar", ["-tzf", tarball]).trim().split("\n");
  assert.equal(contents.filter(file => file === "package/LICENSE.md").length, 1);
  assert.equal(run("tar", ["-xOzf", tarball, "package/LICENSE.md"]), readFileSync(join(root, "LICENSE.md"), "utf8"));
  assert.ok(contents.some(file => file === "package/dist/index.js"));
  assert.ok(contents.some(file => file === "package/LICENSE.md"));
  assert.ok(contents.every(file => !file.startsWith("package/src/") && !file.startsWith("package/scripts/")));
  assert.ok(contents.every(file => !/(?:\.test\.|-fixture\.|\/__(?:tests|fixtures)__\/|\/test-helpers\/|node_modules\/|\.env$)/.test(file)));
  const packed = JSON.parse(run("tar", ["-xOzf", tarball, "package/package.json"]));
  assert.ok(!JSON.stringify(packed).includes("workspace:"));
  assert.deepEqual(Object.keys(packed.exports).sort(), [...stableEntries, ...internalEntries].sort());
  assert.deepEqual(packed.sideEffects, sideEffects);
  for (const entry of Object.values(packed.exports)) {
    const targets = typeof entry === "string" ? [entry] : [entry.types, entry.import];
    for (const target of targets) assert.ok(contents.includes(`package/${target.slice(2)}`), `Missing packed export: ${target}`);
  }
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "barry-sdk-package-consumer", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", tarball, `typescript@${source.devDependencies.typescript}`, `@types/node@${source.devDependencies["@types/node"]}`]);
  const bagDocs = readFileSync(join(root, "sdk/docs/bags.md"), "utf8");
  const callingChapter = bagDocs.split("## Calling Barry from a bag")[1];
  assert.ok(callingChapter, "Missing bag caller documentation");
  const callerSnippet = /```ts\n([\s\S]*?)```/.exec(callingChapter)?.[1];
  assert.ok(callerSnippet, "Missing bag caller TypeScript example");
  writeFileSync(join(scratch, "consumer-bag-docs.ts"), callerSnippet);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", "consumer-bag-docs.ts"]);
  writeFileSync(join(scratch, "consumer-stable.ts"), stableEntries.map((entry, index) => {
    const specifier = entry === "." ? "@barry-rocks/sdk" : `@barry-rocks/sdk${entry.slice(1)}`;
    return entry === "./openapi.json"
      ? `import entry${index} from '${specifier}' with { type: 'json' }; void entry${index};`
      : `import * as entry${index} from '${specifier}'; void entry${index};`;
  }).join("\n") + `
import { installationRoot, barryCurrentDir, barryReleasesDir, installationPath } from '@barry-rocks/sdk/services';
import { installedProgramPath, installedCommand, runningNodePath } from '@barry-rocks/sdk/internal/services';
void installationRoot; void barryCurrentDir; void barryReleasesDir; void installationPath;
void installedProgramPath; void installedCommand; void runningNodePath;
`);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", "--resolveJsonModule", "consumer-stable.ts"]);
  writeFileSync(join(scratch, "consumer.ts"), `
import { Barry, BarryError, type ConnectOptions, type Tool, type Identity } from '@barry-rocks/sdk';
import { fakeIdentities } from '@barry-rocks/sdk/testing';
const options: ConnectOptions = {baseUrl:'https://fixture.example', services:{baseUrl:'https://mcp.fixture.example',secret:'fixture'}, identities:{baseUrl:'https://identities.fixture.example', resolveCredential:async ({signal}) => {signal.throwIfAborted(); return 'device-token';}}};
Barry.connect(options);
const tools: Promise<Tool[]> = Barry.identity('bux').session('s1').tools();
const everyone: PromiseLike<Identity[]> = Barry.at(options).identities();
void tools; void everyone;
void Barry.services(); void Barry.service('x').start();
Barry.use(fakeIdentities({ get: async () => { throw new BarryError('not_found', 'no such identity'); } }));
Barry.reset();
void Barry.at(options).identity('bux').start({prompt:'Begin'});
void Barry.at(options).scheduleOnce({action:'bag:script',dueAt:new Date(),attempts:3});
`);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", "consumer.ts"]);
  writeFileSync(join(scratch, "consumer-providers.ts"), `
import { loadModelProviders, type ModelProviders, type InstalledModelProvider } from '@barry-rocks/sdk/adapters/models';
import type { VendorFactories } from '@barry-rocks/sdk/adapters/models';
const providers: ModelProviders = loadModelProviders({file:'./model-providers.json'});
const selected: InstalledModelProvider[] = providers.installed();
const factories: Promise<VendorFactories> = providers.load();
void selected; void factories;
`);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", "consumer-providers.ts"]);
  writeFileSync(join(scratch, "consumer-auth.ts"), `
import type { Request } from 'express';
import { authorizeRequest, revalidateRequestAuthorization } from '@barry-rocks/sdk/internal/auth';
import { authenticateCredential, type CredentialAuthorization, type CredentialPolicy } from '@barry-rocks/sdk/internal/auth';
import { mintWorkflowSessionCredential, verifyWorkflowSessionCredential, type WorkflowSessionCredential } from '@barry-rocks/sdk/internal/auth';
const workflowSecret = 'workflow_packed_fixture_signing_secret';
const workflow: WorkflowSessionCredential = verifyWorkflowSessionCredential(mintWorkflowSessionCredential(workflowSecret,{credentialId:'11111111-1111-4111-8111-111111111111',actorId:1,identityId:7,sessionId:'job',identity:'fixture',scopeFingerprint:'a'.repeat(64),expiresAt:Date.now()+60000}),workflowSecret);
const workflowActor: number = workflow.actorId;
const workflowIdentity: number = workflow.identityId;
void workflowActor; void workflowIdentity;
const middleware = authorizeRequest({verifyCredential:async () => ({kind:'installation',actorId:1,credentialId:'installation'}),policy:() => null});
const recheck: (request: Request, signal?: AbortSignal) => Promise<boolean> = revalidateRequestAuthorization;
const authorization: CredentialAuthorization | null = await authenticateCredential('fixture',{verifyCredential:async () => ({kind:'device',actorId:1,credentialId:'device',scopes:['sessions:read'],identityIds:[1]})});
const policy: CredentialPolicy = {scopes:['sessions:read'],authorize:(principal,signal) => {signal.throwIfAborted(); return principal.actorId === 1;}};
if (authorization) {const permitted: boolean = await authorization.authorize(policy); void permitted; authorization.dispose();}
void middleware; void recheck;
`);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", "consumer-auth.ts"]);
  writeFileSync(join(scratch, "consumer-browser.ts"), `
import { Barry, type ConnectOptions, type CredentialResolver } from '@barry-rocks/sdk';
import { AgUiConnection, type AgUiSubscriptionOptions } from '@barry-rocks/sdk/apps';
const resolveCredential: CredentialResolver = async ({signal}) => { signal.throwIfAborted(); return 'device-token'; };
const options: ConnectOptions = {baseUrl:'https://fixture.example',resolveCredential};
void Barry.at(options).identity('bux').sessions();
const streamOptions: AgUiSubscriptionOptions = {after:'1:0', reconnect:{maxAttempts:2}, signal:new AbortController().signal};
const stream = new AgUiConnection({baseUrl:'https://fixture.example/api/v2/sessions', resolveCredential});
void stream.subscribe('session', streamOptions);
stream.close();
`);
  writeFileSync(join(scratch, "tsconfig.browser.json"), JSON.stringify({
    compilerOptions: { noEmit:true, strict:true, module:"NodeNext", moduleResolution:"NodeNext", target:"ES2023", lib:["ES2023","DOM"], types:[] },
    files:["consumer-browser.ts"],
  }));
  run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.browser.json"]);
  writeFileSync(join(scratch, "client.mjs"), `
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (['fs','node:fs','node:fs/promises','child_process','node:child_process','better-sqlite3','tsx'].includes(specifier)) throw Error('Eager Node dependency: '+specifier);
  return next(specifier, context);
}});
const publicSdk = await import('@barry-rocks/sdk');
assert.ok(!('BarryClient' in publicSdk) && !('BarryApiError' in publicSdk));
const { Barry } = publicSdk;
const { AgUiConnection } = await import('@barry-rocks/sdk/apps');
let streamRequests = 0;
const stream = new AgUiConnection({baseUrl:'https://fixture.example/api/v2/sessions', fetch:async (url, init) => {
  streamRequests++;
  assert.equal(new URL(url).pathname, '/api/v2/sessions/session/events');
  assert.equal(new Headers(init.headers).get('Accept'), 'text/event-stream');
  return new Response('id: 1:0\\ndata: {"type":"RUN_ERROR","message":"fixture"}\\n\\n', {headers:{'Content-Type':'text/event-stream'}});
}});
const delivered = [];
for await (const event of stream.subscribe('session')) delivered.push(event.cursor);
assert.deepEqual(delivered, ['1:0']);
assert.equal(streamRequests, 1);
stream.close();
let requests = 0;
const fixtureFetch = async (url, init) => {
  requests++;
  const endpoint = new URL(url);
  assert.ok(['/api/v1/sessions/missing','/api/v1/sessions','/api/v1/events'].includes(endpoint.pathname));
  assert.equal(init.headers.Authorization, 'Bearer fixture-token');
  if (endpoint.pathname.endsWith('/missing')) return new Response('{}', {status:404});
  const key = endpoint.pathname.endsWith('/events') ? 'events' : 'sessions';
  return Response.json({[key]:[], nextCursor:key==='sessions' && !endpoint.searchParams.has('cursor') ? 'next' : null});
};
const client = Barry.at({baseUrl:'https://fixture.example', secret:'fixture-token', fetch: fixtureFetch});
assert.equal(requests, 0);
await assert.rejects(client.identity(1).session('missing').get(), {name:'BarryError', reason:'not_found'});
assert.equal(requests, 1);
const sessions = client.identity(1).sessions();
assert.equal(requests, 1);
assert.deepEqual(await sessions, []);
assert.equal(requests, 3);
for await (const event of client.events()) throw Error('Unexpected record');
assert.equal(requests, 4);
await assert.rejects(async () => await Barry.events(), {name:'BarryError', reason:'unavailable'});
Barry.connect({baseUrl:'https://fixture.example', secret:'fixture-token', fetch: fixtureFetch});
assert.deepEqual(await Barry.events(), []);
assert.equal(requests, 5);
await assert.rejects(Barry.identity(1).session('s').tools(), {name:'BarryError', reason:'unavailable'});
Barry.reset();
`);
  run(process.execPath, ["client.mjs"]);
  writeFileSync(join(scratch, "browser.mjs"), `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { build } from 'esbuild';
const bundle = await build({entryPoints:['consumer.ts'], bundle:true, platform:'browser', format:'esm', write:false, metafile:true});
assert.ok(bundle.outputFiles[0].contents.length > 0);
assert.ok(Object.keys(bundle.metafile.inputs).every(file => !file.includes('sdk/dist/services/')));
for (const entry of ['@barry-rocks/sdk/testing', '@barry-rocks/sdk/apps']) {
  const built = await build({stdin:{contents:'export * from "'+entry+'";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false,metafile:true});
  assert.ok(Object.keys(built.metafile.inputs).every(file => !file.includes('sdk/dist/services/')));
}
const edge = await build({stdin:{contents:'export * from "@barry-rocks/sdk/logging/edge";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,metafile:true});
assert.ok(Object.keys(edge.metafile.inputs).every(file => !file.includes('/pino')));
const stores = await build({stdin:{contents:'export { installStoreContext } from "@barry-rocks/sdk/internal/stores";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,metafile:true,external:['better-sqlite3']});
assert.ok(Object.keys(stores.metafile.inputs).some(file => file.endsWith('/sdk/dist/stores/context.js')));
writeFileSync('store-binding.mjs', stores.outputFiles[0].text);
console.log('Browser client bundle: '+bundle.outputFiles[0].contents.length+' bytes');
`);
  process.stdout.write(run(process.execPath, ["browser.mjs"]));
  const storeProbeEnv = { ...process.env, BARRY_HOME: join(scratch, "store-binding-home") };
  for (const key of Object.keys(storeProbeEnv)) if (/^BARRY_.*_DB$/.test(key)) delete storeProbeEnv[key];
  run(process.execPath, ["--input-type=module", "--eval", `
import assert from 'node:assert/strict';
const resolverKey = Symbol.for('barry.store-binding-resolver.v1');
const stores = await import("./" + "store-binding.mjs");
assert.equal(typeof globalThis[resolverKey], 'undefined');
stores.installStoreContext();
assert.equal(typeof globalThis[resolverKey], 'function');
const paths = await import('@barry-rocks/sdk/services');
const programs = await import('@barry-rocks/sdk/internal/services');
for (const name of ['installationRoot','barryCurrentDir','barryReleasesDir','installationPath']) assert.equal(typeof paths[name], 'function', name);
for (const name of ['installedProgramPath','installedCommand','runningNodePath']) assert.equal(typeof programs[name], 'function', name);
`], scratch, storeProbeEnv);
  writeFileSync(join(scratch, "workflows.mjs"), `
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { WorkflowOwner, ProcessExecutor, snapshotWorkflows, restoreWorkflows } from '@barry-rocks/sdk/internal/workflows';
const path = join(import.meta.dirname, 'workflows.db');
const { SHIPPED_VENDORS } = await import('@barry-rocks/sdk/adapters/models');
assert.ok(SHIPPED_VENDORS.length > 0);
const owner = new WorkflowOwner({id:'package-owner', path, artifacts:[], activityArtifacts:{}, executor:new ProcessExecutor()});
try {
  const backup = join(import.meta.dirname, 'backup');
  const restored = join(import.meta.dirname, 'restored');
  const snapshot = await snapshotWorkflows(path, backup, 'package-owner', []);
  assert.equal(snapshot.owner, 'package-owner');
  const manifest = await restoreWorkflows(backup, restored, 'package-owner', true);
  assert.equal(manifest.owner, 'package-owner');
} finally { await owner.drain(); owner.close(); }
`);
  run(process.execPath, ["workflows.mjs"]);
  writeFileSync(join(scratch, "stores.ts"), `
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {activateStoreGeneration,activeStoreRoot,prepareStoreGeneration,validatePreparedStoreGeneration} from '@barry-rocks/sdk/internal/stores';
const root=join(import.meta.dirname,'stores');
for(const id of ['previous']) {
  const directory=join(root,'generations',id); mkdirSync(join(directory,'node/records'),{recursive:true});
  const db=new DatabaseSync(join(directory,'node/records/default.db'));
  try {db.exec("PRAGMA journal_mode=WAL; CREATE TABLE history(value TEXT); INSERT INTO history VALUES('"+id+"'); CREATE TABLE status(state TEXT); INSERT INTO status VALUES('active'); CREATE TRIGGER sealed_history BEFORE UPDATE ON history WHEN (SELECT state FROM status)='sealed' BEGIN SELECT RAISE(ABORT,'sealed history'); END;");} finally {db.close();}
}
writeFileSync(join(root,'active.json'),JSON.stringify({id:'previous'}));
writeFileSync(join(root,'generations/previous/unknown.txt'),'preserved file');
const prepared=await prepareStoreGeneration({root,previousId:'previous',servicesStopped:true,build:async directory=>{
  const db=new DatabaseSync(join(directory,'node/records/default.db')); try {db.exec("PRAGMA journal_mode=WAL; UPDATE history SET value='candidate'");} finally {db.close();}
}});
await validatePreparedStoreGeneration(root,prepared.id);
assert.equal(readFileSync(join(prepared.directory,'unknown.txt'),'utf8'),'preserved file');
const activation=await activateStoreGeneration({root,id:prepared.id,previousId:'previous',servicesStopped:true,
  validate:async directory=>{const db=new DatabaseSync(join(directory,'node/records/default.db'),{readOnly:true}); try {assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode,'delete');assert.equal(db.prepare('SELECT value FROM history').get()?.value,'candidate');} finally {db.close();} await validatePreparedStoreGeneration(root,prepared.id);},
  sealPrevious:async directory=>{const db=new DatabaseSync(join(directory,'node/records/default.db')); try {db.exec("PRAGMA synchronous=FULL; UPDATE status SET state='sealed'");} finally {db.close();}}
});
assert.equal(activation.state,'active'); assert.equal(activeStoreRoot(root),prepared.directory);
assert.equal(JSON.parse(readFileSync(join(root,'activations',prepared.id+'.json'),'utf8')).id,prepared.id);
const old=new DatabaseSync(join(root,'generations/previous/node/records/default.db'));
try {assert.equal(old.prepare('SELECT value FROM history').get()?.value,'previous');assert.throws(()=>old.exec("UPDATE history SET value='late'"),/sealed history/);} finally {old.close();}
`);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "stores.ts"]);
  run(process.execPath, ["stores.js"]);
  writeFileSync(join(scratch, "auth.mjs"), `
import assert from 'node:assert/strict';
import express from 'express';
import { authorizeRequest, revalidateRequestAuthorization } from '@barry-rocks/sdk/internal/auth';
import { authenticateCredential, requestCredential } from '@barry-rocks/sdk/internal/auth';
import { mintWorkflowSessionCredential, verifyWorkflowSessionCredentialForSession } from '@barry-rocks/sdk/internal/auth';
import { scopeFingerprint } from '@barry-rocks/sdk/bounds';
const workflowSecret = 'workflow_packed_fixture_signing_secret';
const evidence = {identity:'fixture',traits:[],bound:null,tools:{}};
const scope = {...evidence,fingerprint:scopeFingerprint(evidence)};
const workflow = mintWorkflowSessionCredential(workflowSecret,{credentialId:'11111111-1111-4111-8111-111111111111',actorId:1,identityId:7,sessionId:'job',identity:'fixture',scopeFingerprint:scope.fingerprint,expiresAt:Date.now()+60000});
const record = {id:'job',state:'open',ended_at:null,workflow_credential_id:'11111111-1111-4111-8111-111111111111',user_id:1,identity_id:7,metadata:{workflow_scope:scope,workflow_identity_id:7}};
assert.equal(verifyWorkflowSessionCredentialForSession(workflow,workflowSecret,'job',record).actorId,1);
assert.throws(() => verifyWorkflowSessionCredentialForSession(workflow,workflowSecret,'job',{...record,user_id:2}));
assert.throws(() => verifyWorkflowSessionCredentialForSession(workflow,workflowSecret,'job',{...record,identity_id:8}));
assert.throws(() => verifyWorkflowSessionCredentialForSession(workflow,workflowSecret,'job',{...record,workflow_credential_id:null}));
assert.throws(() => verifyWorkflowSessionCredentialForSession(workflow,workflowSecret,'job',{...record,state:'closed'}));
const credential = requestCredential({headers:{authorization:'Bearer fixture'}});
assert.equal(credential,'fixture');
let validCredential = true;
const authorization = await authenticateCredential(credential,{verifyCredential:() => validCredential ? {kind:'device',actorId:1,credentialId:'device',scopes:['sessions:read'],identityIds:[1]} : null});
assert.ok(authorization);
assert.equal(await authorization.authorize({scopes:['sessions:read'],authorize:() => true}),true);
assert.equal(await authorization.authorize({scopes:['sessions:turn'],authorize:() => true}),false);
validCredential = false;
assert.equal(await authorization.revalidate(),false);
authorization.dispose();
let active = true, admitted;
const ready = new Promise(resolve => {admitted = resolve;});
const app = express();
app.use(authorizeRequest({verifyCredential:credential => active && credential === 'fixture' ? {kind:'installation',actorId:1,credentialId:'installation'} : null,policy:() => null}));
app.use((request,response) => {response.flushHeaders();admitted({request,response});});
const server = app.listen(0,'127.0.0.1');
await new Promise(resolve => server.once('listening',resolve));
try {
  const result = await fetch('http://127.0.0.1:'+server.address().port+'/stream',{headers:{Authorization:'Bearer fixture'}});
  assert.equal(result.status,200);
  const {request,response} = await ready;
  try {
    assert.equal(await revalidateRequestAuthorization(request),true);
    active = false;
    assert.equal(await revalidateRequestAuthorization(request),false);
  } finally {response.end();}
  await result.text();
} finally {await new Promise(resolve => server.close(resolve));}
`);
  run(process.execPath, ["auth.mjs"]);
  console.log(`SDK packed consumer verified (${contents.length} files, all export targets, strict TypeScript, browser bundle, plain Node HTTP/auth revalidation, workflow snapshot/restore).`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
