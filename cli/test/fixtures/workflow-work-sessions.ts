/** Actual managed Sessions -> signed Work admission -> owner/brokers -> invited
 * worker -> retained Pi. Setup seeds real scratch stores; no authorization is fabricated. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import { workAdmissionSchema, workReceiptSchema } from "@barry-rocks/sdk/internal/workflows";

const repo = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
const accepted = z.object({ run_id: z.string(), work_id: z.string(), workflow_id: z.string(), idempotency_key: z.string(), created: z.boolean() });
type Child = { process: ReturnType<typeof spawn>; done: boolean; stdout: string; stderr: string; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };
export async function workflowWorkSessions(options: { holdProvider?: boolean; providerOutput?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "work-sessions-installed-"))), home = join(root, "home"), bag = join(root, "fixtureagent"), action = join(bag, "actions/probe"), secrets = join(root, "selected-secrets");
  for (const path of [home, join(home, "config"), join(home, "app-support"), bag, action, secrets]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const privateJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  const secret = "managed-work-sessions-authentication-secret", actorKey = "managed-work-sessions-actor-key-thirty-two-bytes", selectedKey = "selected-only-provider-" + randomUUID();
  const config = join(home, "config/barry.yaml"), agentManifestFile = join(root, "agent-catalog.json"), workerConfig = join(root, "worker.json"), profiles = join(root, "profiles.json"), registration = join(root, "registration.json"), boundsFile = join(root, "bounds.json"), keys = join(root, "keys.json"), workerDirectory = join(root, "worker"), endpointDb = join(root, "endpoint.db");
  privateJson(config, { secrets: { BARRY_SECRET: { in: ".env" }, BARRY_WORKFLOW_ACTOR_KEY: { in: ".env" } } });
  writeFileSync(join(home, "app-support/env"), `BARRY_SECRET=${secret}\nBARRY_WORKFLOW_ACTOR_KEY=${actorKey}\nOPENAI_API_KEY=wrong-installation\n`, { mode: 0o600 });
  writeFileSync(join(secrets, ".env"), `OPENAI_API_KEY=${selectedKey}\nANTHROPIC_API_KEY=selected-harness-key\nUNDECLARED_CANARY=must-not-leak\n`, { mode: 0o600 });
  privateJson(keys, { "workflows.sessions.identity": [{ id: "fixture", secret: "managed-agent-admission-delegation-key", not_before: Date.now() - 1000, not_after: Date.now() + 3600000 }] });
  privateJson(join(action, "action.yaml"), { name: "probe", description: "Actual Work Sessions retained execution", context: "none", prompt: "Return an object with answer equal to 42.", timeout: 60,
    output_schema: { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false } });
  const children: Child[] = [], services: Child[] = [], requests: { authorization?: string; body: unknown; fence: unknown; host: unknown; endpoint: unknown }[] = [], providerErrors: string[] = [];
  let sessionsDb = "", hostDb = "", ownerDb = "";
  const read = <T>(path: string, operation: (db: Database.Database) => T): T => { const db = new Database(path, { readonly: true });try { return operation(db); } finally { db.close(); } };
  const provider = createServer((req, res) => {
    let raw = "";req.on("data", bytes => { raw += String(bytes); });req.on("end", () => {
      try {
        assert.equal(req.headers.authorization, `Bearer ${selectedKey}`);
        const fence = read(sessionsDb, db => db.prepare("SELECT phase,handle_json,input_at FROM session_workflow_settlements ORDER BY rowid DESC LIMIT 1").get()) as { phase: string; handle_json: string; input_at: string };
        assert.equal(fence.phase, "input");assert.ok(fence.input_at);assert.ok(JSON.parse(fence.handle_json).pid);
        const host = read(hostDb, db => db.prepare("SELECT state FROM resource_reservations").all()), endpoint = read(endpointDb, db => db.prepare("SELECT state FROM resource_reservations").all());
        const body = JSON.parse(raw);requests.push({ authorization: req.headers.authorization, body, fence, host, endpoint });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "work-sessions-real", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (options.holdProvider) { chunk({ role: "assistant" }, null); return; }
        chunk({ role: "assistant", content: options.providerOutput ?? '{"answer":42}' }, null);chunk({}, "stop");res.end("data: [DONE]\n\n");
      } catch (error) { providerErrors.push(String(error));res.writeHead(500);res.end(); }
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  privateJson(join(bag, "bag.yaml"), { name: "fixtureagent", description: "Static local SSE provider and prompt action", vendors: [{ id: "openai", label: "Local actual provider", baseUrl: endpoint,
    credential: { env: "OPENAI_API_KEY" }, models: [{ id: "probe", label: "Actual local model", kind: "completion" }] }] });
  const registry = { bags: { workflows: { type: "local", path: join(repo, "bags/workflows") }, sessions: { type: "local", path: join(repo, "bags/sessions") }, pi: { type: "local", path: join(repo, "adapters/sessions/pi") }, fixtureagent: { type: "local", path: bag } } };
  privateJson(join(home, "app-support/bags.snapshot.json"), registry);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: tmpdir(), BARRY_HOME: home, BARRY_DIR: repo, BARRY_SECRET: secret, OPENAI_API_KEY: "ambient-must-not-run", ANTHROPIC_API_KEY: "ambient-harness-decoy", LC_ALL: "C" };
  const launch = (args: string[], extra: NodeJS.ProcessEnv = {}, cwd = join(repo, "cli")) => {
    const processChild = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    const child: Child = { process: processChild, done: false, stdout: "", stderr: "", closed: Promise.resolve({ code: null, signal: null }) };
    processChild.stdout!.on("data", bytes => { child.stdout = (child.stdout + String(bytes)).slice(-120000); });processChild.stderr!.on("data", bytes => { child.stderr = (child.stderr + String(bytes)).slice(-120000); });
    child.closed = new Promise(resolve => processChild.once("close", (code, signal) => { child.done = true;resolve({ code, signal }); }));children.push(child);return child;
  };
  const setup = async (source: string) => { const child = launch(["--import", "tsx", "--input-type=module", "--eval", source], { VITEST: "true" });const result = await child.closed;assert.equal(result.code, 0, child.stderr);return child.stdout; };
  const wait = async (test: () => boolean | Promise<boolean>, ms: number, description: string, child?: Child) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (child?.done) throw new Error(`${description} exited before readiness: ${child.stderr || child.stdout}`);if (await test()) return;await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error(`${description} timed out: ${child?.stderr ?? ""}`);
  };
  const diagnostics = () => children.map(child => ({ pid: child.process.pid, done: child.done, code: child.process.exitCode, signal: child.process.signalCode, stdout: child.stdout, stderr: child.stderr }));
  const preserve = (stage: string) => {
    privateJson(join(root, `failure-${stage}.json`), { children: diagnostics(), requests, providerErrors });
    // Raw crash-state copies, not transactionally consistent SQLite backups.
    // Prune volatile runtime packages before walking. Recursive readdir follows
    // their dependency graph and can race normal runtime removal at cessation.
    const paths: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (path === "raw-before-cleanup" || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (entry.name === "runtime" && /(?:^|\/)(?:execution-spool|registration-spool)\//.test(path)) continue;
          visit(path);
        } else if (entry.isFile()) paths.push(path);
      }
    };
    visit("");
    for (const path of paths) {
      const database = /\.(db|sqlite)(-wal|-shm)?$/.test(path);
      const spool = /(?:^|\/)(?:execution-spool|registration-spool)\//.test(path) && !path.includes("/runtime/") && /\.(?:json|ndjson|jsonl|log)$/.test(path);
      if ((!database && !spool) || !lstatSync(join(root, path)).isFile()) continue;
      const target = join(root, "raw-before-cleanup", path);mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });copyFileSync(join(root, path), target);
    }
  };
  const stopChild = async (child: Child) => { if (!child.done) { child.process.kill("SIGTERM");try { await wait(() => child.done, 30000, "managed shutdown"); } catch (error) { if (!child.done) { child.process.kill("SIGKILL");await child.closed; }throw error; } }assert.deepEqual(await child.closed, { code: 0, signal: null }, child.stderr); };
  const close = async (retain = false) => {
    const errors: unknown[] = [];
    if (retain) try { preserve("before-cleanup"); } catch (error) { errors.push(error); }
    for (const child of [...services, ...[...children].reverse().filter(child => !services.includes(child))]) try { await stopChild(child); } catch (error) { errors.push(error); }
    provider.closeAllConnections();await new Promise<void>(resolve => provider.close(() => resolve()));
    if (retain || errors.length) try { privateJson(join(root, "failure-after-cleanup.json"), { children: diagnostics(), requests, providerErrors }); } catch (error) { errors.push(error); }
    if (!retain && !errors.length) rmSync(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "Managed Work Sessions cleanup failed; retained " + root);
  };
  try {
    const metadata = { bags: ["workflows", "fixtureagent", "pi"], secrets: Object.fromEntries(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].map(name => [name, { reference: { in: ".env" }, directory: secrets }])) };
    const seed = JSON.parse(await setup(`import{Barry}from'@barry-rocks/sdk';import{barryStoresDir,bagDataDir}from'@barry-rocks/sdk/services';import{bootstrapStoreGeneration,withStoreContext}from'@barry-rocks/sdk/internal/stores';import{migratedStorePath}from'@barry-rocks/sdk/stores';
      import{identities,owner}from'@barry-rocks/identities-bag';import{identitiesSqlite}from'@barry-rocks/identities-bag/testing';import{installationRegistry}from'@barry-rocks/sdk/internal/nodes';import{boundFingerprint}from'@barry-rocks/sdk/bounds';
      import{getSessionsSqlite}from'@barry-rocks/sessions-bag/store/sessions-db';import{mkdirSync}from'node:fs';import{join}from'node:path';
      bootstrapStoreGeneration(barryStoresDir());const db=identitiesSqlite();db.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'bridge-owner','user','Bridge owner')").run();db.prepare("INSERT INTO identities(id,token,actor_id,name,metadata) VALUES(42,'bridge-identity',1,'bridge',?)").run(${JSON.stringify(JSON.stringify(metadata))});
      owner.installation().bind({actorId:1,actorToken:'bridge-owner'});Barry.use(identities);
      const registry=installationRegistry(),identity=registry.identityId(42),invited=registry.inviteWorker('actual-sessions-worker',['agents:'+boundFingerprint({reference:'fixtureagent:probe'})+'@1']);
      const artifactRoot=join(bagDataDir('workflows'),'work-artifacts');mkdirSync(artifactRoot,{recursive:true,mode:0o700});const sessionsDb=withStoreContext({identity},()=>getSessionsSqlite().name),ownerDb=migratedStorePath('workflows','workflows',()=>join(bagDataDir('workflows'),'workflows.db'),'workflows','node');
      process.stdout.write(JSON.stringify({identity,installation:registry.id,worker:invited.worker.id,credential:invited.credential,artifactRoot,sessionsDb,ownerDb}));process.exit(0);`)) as { identity: string; installation: string; worker: string; credential: string; artifactRoot: string; sessionsDb: string; ownerDb: string };
    sessionsDb = seed.sessionsDb;hostDb = join(seed.artifactRoot, "..", "work-resources.db");ownerDb = seed.ownerDb;
    const credentialPath = join(root, "worker-credential");writeFileSync(credentialPath, seed.credential, { mode: 0o600 });
    const reservePort = async () => { const socket = createServer();await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));const port = (socket.address() as { port: number }).port;await new Promise<void>(resolve => socket.close(() => resolve()));return port; };
    const runtimeUrl = `http://127.0.0.1:${await reservePort()}`, apiUrl = `http://127.0.0.1:${await reservePort()}`;
    const runtimePort = Number(new URL(runtimeUrl).port), apiPort = Number(new URL(apiUrl).port);
    const endpointBroker = { id: "fixture-agent-endpoint", path: endpointDb, limits: { "fixture-endpoint": { kind: "endpoint", concurrency: 1, input_tokens: 100000, output_tokens: 100000, cost_micros: 1000000 } } };
    privateJson(profiles, { version: 1, catalog: agentManifestFile, worker_id: seed.worker, endpoint_broker: endpointBroker, actions: [{ reference: "fixtureagent:probe", harness: "pi", model: "openai/probe", cwd: root, budget_policy: "reservation-only", endpoint_resource: "fixture-endpoint", max_input_tokens: 4096, max_cost: 0.1 }] });
    privateJson(workerConfig, { version: 1, directory: workerDirectory, artifact_root: seed.artifactRoot, catalog: agentManifestFile, owner: { id: seed.installation, url: runtimeUrl, credential_file: credentialPath }, capacity: 1 });
    privateJson(boundsFile, { [seed.identity]: { types: ["action-agent"], operations: ["start", "get", "list", "cancel"], payloadRead: true } });
    await setup(`import{loadAdapters}from'@barry-rocks/sdk/internal/adapters';import{barryAdaptersPath}from'@barry-rocks/sdk/services';import{writeFileSync,realpathSync}from'node:fs';
      const selected=await loadAdapters({file:barryAdaptersPath()}).add(${JSON.stringify(join(repo, "adapters/sessions/pi"))});writeFileSync(${JSON.stringify(registration)},JSON.stringify({version:1,harnesses:[selected.id],allowedRoots:[realpathSync(${JSON.stringify(repo)}),realpathSync(${JSON.stringify(join(repo, "node_modules/.pnpm"))})],registrationTimeoutMs:120000}),{mode:0o600});process.exit(0);`);
    privateJson(config, { secrets: { BARRY_SECRET: { in: ".env" }, BARRY_WORKFLOW_ACTOR_KEY: { in: ".env" } }, services: {
      "sessions.api": { env: [`BARRY_WORKFLOW_DELEGATION_KEYS=${keys}`, `BARRY_WORKFLOW_RUNTIME_REGISTRATION=${registration}`, `BARRY_WORKFLOW_AGENT_PROFILES=${profiles}`, `BARRY_WORKFLOW_SESSIONS_WORKER=${workerConfig}`] },
      "workflows.runtime": { env: [`BARRY_WORKFLOW_DELEGATION_KEYS=${keys}`, `BARRY_WORKFLOW_AGENT_CATALOG=${agentManifestFile}`, `BARRY_WORKFLOW_POLICY=${boundsFile}`, "BARRY_WORKFLOW_ARTIFACT_BYTES=268435456"] },
    } });
    await setup(`import{loadAllBags,loadRegistry}from'@barry-rocks/sdk/internal/bags';import{buildServiceSpecs}from${JSON.stringify(pathToFileURL(join(repo, "cli/src/services/specs.ts")).href)};import{writeFileSync}from'node:fs';
      const {specs,problems}=buildServiceSpecs(await loadAllBags(),loadRegistry());const keys=['sessions.api','workflows.runtime'];if(problems.some(problem=>keys.includes(problem.key)))throw Error(JSON.stringify(problems));
      const selected=Object.fromEntries(keys.map(key=>{const spec=specs.find(spec=>spec.key===key);if(!spec)throw Error('Missing actual service '+key);return[key,{...spec,port:key==='sessions.api'?${apiPort}:${runtimePort}}]}));writeFileSync(${JSON.stringify(join(home, "app-support/service-definitions.json"))},JSON.stringify(selected));process.exit(0);`);
    privateJson(join(home, "app-support/bag-resources.json"), { version: 2, generated: new Date().toISOString(), resources: { "sessions.api": { bag: "sessions", name: "api", kind: "service", url: apiUrl }, "workflows.runtime": { bag: "workflows", name: "runtime", kind: "service", url: runtimeUrl } } });
    const entry = (key: string) => ["--import", "tsx", join(repo, "cli/src/services/entry.ts"), join(home, "app-support"), key];
    const poisonedAmbient = Object.fromEntries(["BARRY_WORKFLOW_AGENT_PROFILES", "BARRY_WORKFLOW_SESSIONS_WORKER", "BARRY_WORKFLOW_AGENT_CATALOG", "BARRY_WORKFLOW_RUNTIME_REGISTRATION", "BARRY_WORKFLOW_DELEGATION_KEYS", "BARRY_WORKFLOW_POLICY"].map(name => [name, join(root, "absent-ambient", name)]));
    let api = launch(entry("sessions.api"), poisonedAmbient);services.push(api);
    await wait(async () => { try { return (await fetch(apiUrl + "/health/live")).status === 200 && existsSync(agentManifestFile); } catch { return false; } }, 120000, "Sessions registration and publication", api);
    let runtime = launch(entry("workflows.runtime"), poisonedAmbient);services.push(runtime);
    await wait(() => (runtime.stdout + runtime.stderr).includes("runtime ready"), 20000, "Work runtime", runtime);
    await setup(`import{withStoreContext}from'@barry-rocks/sdk/internal/stores';import{getSessionsSqlite}from'@barry-rocks/sessions-bag/store/sessions-db';withStoreContext({identity:${JSON.stringify(seed.identity)}},()=>getSessionsSqlite().prepare("INSERT INTO sessions(id,user_id,identity_id,bags,metadata) VALUES('owned',1,42,?,'{}')").run(JSON.stringify(['workflows','fixtureagent','pi'])));process.exit(0);`);
    const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
    const request = { request_id: randomUUID(), idempotency_key: "actual-agent/" + randomUUID(), inputs: {} };
    const submit = (signal?: AbortSignal) => fetch(apiUrl + "/api/v1/actions/fixtureagent%3Aprobe/work-start-agent?session_id=owned", { method: "POST", headers, body: JSON.stringify(request), signal });
    const ownerRows = () => read(ownerDb, db => db.prepare("SELECT record FROM workflow_work_admissions").all()) as { record: string }[];
    const receipt = () => read(join(workerDirectory, "executor.sqlite"), db => { const row = db.prepare("SELECT receipt FROM execution_receipts ORDER BY rowid DESC LIMIT 1").get() as { receipt: string } | undefined;return row && JSON.parse(row.receipt); });
    // One fixed observation cutoff per accepted Work: its retained execution
    // contract plus receipt propagation. Polling and replay never extend it.
    const observationCutoffs = new Map<string, number>();
    const observationRemaining = (workId: string) => {
      let cutoff = observationCutoffs.get(workId);
      if (cutoff === undefined) {
        const admissions = ownerRows().map(row => workAdmissionSchema.parse(JSON.parse(row.record))).filter(row => row.work_id === workId);
        assert.equal(admissions.length, 1, "Observation requires one actual accepted Work");
        const admission = admissions[0]!;
        assert.equal(admission.plan.execution_budget_ms, 60000, "Fixture execution contract must remain 60 seconds");
        const deadline = admission.execution_deadline === null
          ? admission.accepted_at + admission.plan.execution_budget_ms
          : admission.execution_deadline;
        assert.ok(Number.isSafeInteger(admission.accepted_at) && admission.accepted_at >= 0, "Accepted Work must have a valid acceptance timestamp");
        assert.ok(Number.isSafeInteger(deadline) && deadline >= admission.accepted_at, "Accepted Work must have a valid deadline");
        cutoff = deadline + 5000;
        observationCutoffs.set(workId, cutoff);
      }
      return Math.max(0, cutoff - Date.now());
    };
    const result = async (workId: string) => { const response = await fetch(apiUrl + `/api/v1/actions/work-items/${workId}/result?session_id=owned`, { headers });assert.equal(response.status, 200, await response.clone().text());return response.json(); };
    const assertReceiptWithinExecution = (workId: string) => {
      const retained = workReceiptSchema.parse(receipt());
      assert.equal(retained.work_id, workId);
      assert.ok(retained.stages.some(stage => stage.stage === "execution"));
      assert.ok(retained.stages.some(stage => stage.stage === "validation"));
      for (const stage of retained.stages) {
        assert.ok(stage.started_at !== null && stage.completed_at !== null && stage.started_at <= stage.completed_at);
        assert.ok(stage.completed_at <= retained.deadline, "Execution and validation must finish within the unchanged Work deadline");
      }
      assert.ok(retained.committed_at <= retained.deadline, "Receipt must commit within the unchanged Work deadline");
    };
    const awaitReceipt = async (workId: string, validation?: "failed") => {
      await wait(() => {
        const retained = receipt();
        if (!retained) return false;
        assert.equal(retained.work_id, workId);
        if (validation) { assert.equal(retained.validation, validation, "Immutable receipt has unexpected validation");assertReceiptWithinExecution(workId); }
        return true;
      }, observationRemaining(workId), "Accepted Work receipt");
    };
    const awaitOutcome = async (workId: string, expected: boolean) => {
      await wait(async () => {
        const current = await result(workId);
        if (current.outcome !== null && current.outcome !== undefined) {
          assert.equal(current.outcome.ok, expected, "Accepted Work has an unexpected final outcome");
          if (expected) assertReceiptWithinExecution(workId);
          return true;
        }
        const retained = receipt();
        if (retained && expected) assert.equal(retained.outcome, "complete", "Immutable receipt cannot produce successful Work");
        return false;
      }, observationRemaining(workId), "Accepted Work outcome");
    };
    const awaitProviderInput = async (workId: string) => {
      await wait(() => {
        if (requests.length) { assert.equal(requests.length, 1);return true; }
        assert.equal(receipt(), undefined, "Work settled before reaching the provider");
        return false;
      }, observationRemaining(workId), "Accepted Work provider input");
    };
    return { root, home, identity: seed.identity, installation: seed.installation, workerId: seed.worker, selectedKey, requests, providerErrors, request, submit, ownerRows, receipt, diagnostics, close, awaitReceipt, awaitOutcome, awaitProviderInput, result,
      async accept() { const response = await submit();assert.equal(response.status, 201, await response.clone().text());return accepted.parse(await response.json()); },
      async loseAdmissionAcknowledgement() {
        // The relay receives the real committed response, then destroys its
        // client connection without forwarding any response bytes.
        let upstreamError: unknown, clientFailed = false, acceptedAck = false, forwarding: Promise<void> | undefined;
        const upstreamAbort = new AbortController();
        const relay = createServer((_req, res) => {
          if (forwarding) { res.destroy();return; }
          forwarding = (async () => {
            const response = await submit(upstreamAbort.signal);assert.equal(response.status, 201, await response.clone().text());
            accepted.parse(await response.json());acceptedAck = true;
          })().catch(error => { upstreamError = error; }).finally(() => res.destroy());
        });
        await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
        try {
          try { await fetch(`http://127.0.0.1:${(relay.address() as { port: number }).port}`, { method: "POST", signal: AbortSignal.timeout(30000) }); }
          catch { clientFailed = true; }
        } finally {
          upstreamAbort.abort();await forwarding;
          relay.closeAllConnections();await new Promise<void>(resolve => relay.close(() => resolve()));
        }
        if (upstreamError) throw upstreamError;
        assert.equal(acceptedAck, true, "The actual upstream must confirm admission before the acknowledgement is lost");
        assert.equal(clientFailed, true, "Admission relay must lose the acknowledgement");
      },
      async restartAfterCompletion() {
        assert.equal(api.done, false, "Sessions must be live before clean restart");assert.equal(runtime.done, false, "Work runtime must be live before clean restart");
        await stopChild(api);await stopChild(runtime);
        api = launch(entry("sessions.api"), poisonedAmbient);services.push(api);
        await wait(async () => { try { return (await fetch(apiUrl + "/health/live")).status === 200; } catch { return false; } }, 120000, "Sessions restart registration", api);
        runtime = launch(entry("workflows.runtime"), poisonedAmbient);services.push(runtime);
        await wait(() => (runtime.stdout + runtime.stderr).includes("runtime ready"), 20000, "Work runtime restart", runtime);
      },
      async stop(workId: string) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const inspected = await fetch(apiUrl + `/api/v1/actions/work-items/${workId}?session_id=owned`, { headers });
          assert.equal(inspected.status, 200, await inspected.clone().text());
          const current = await inspected.json() as { revision: number };
          const intent = { request_id: randomUUID(), expected_revision: current.revision, reason: "Managed native Stop qualification" };
          const send = () => fetch(apiUrl + `/api/v1/actions/work-items/${workId}/stop?session_id=owned`, { method: "POST", headers, body: JSON.stringify(intent) });
          const response = await send(), body = await response.json() as { error?: string; work_id?: string; request_id?: string; stop_requested?: boolean };
          if (response.status === 409 && body.error === "WorkRevisionConflict") continue;
          assert.equal(response.status, 202, JSON.stringify(body));assert.equal(body.stop_requested, true);assert.equal(body.work_id, workId);assert.equal(body.request_id, intent.request_id);
          const duplicate = await send();assert.equal(duplicate.status, 202, await duplicate.clone().text());assert.deepEqual(await duplicate.json(), body);return;
        }
        throw new Error("Work revision did not stabilize for Stop");
      },
      reservations() { return { host: read(hostDb, db => db.prepare("SELECT state,request FROM resource_reservations").all()), endpoint: read(endpointDb, db => db.prepare("SELECT state,request FROM resource_reservations").all()) }; },
      fences() { return read(sessionsDb, db => db.prepare("SELECT segment_id,phase,handle_json,input_at,ceased_at FROM session_workflow_settlements").all()) as { segment_id: string; phase: string; handle_json: string; input_at: string | null; ceased_at: string | null }[]; },
    };
  } catch (error) { try { await close(true); } catch (cleanup) { throw new AggregateError([error, cleanup], "Work Sessions setup/cleanup failed; preserved " + root); }throw new Error("Work Sessions setup failed; preserved " + root, { cause: error }); }
}
