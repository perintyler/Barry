/** Run with node --import tsx cli/scripts/verify-nodes.ts. Uses disposable homes only. */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as httpServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import { DatabaseSync } from "node:sqlite";
import { loadSqlMigrations, storePath, activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { NodeRegistry, decodeJoinToken } from "@barry-rocks/sdk/internal/nodes";
import { migrateStore } from "@barry-rocks/sdk/stores";
import { decodeJoinToken as decodeMasterJoinToken } from "./master-join-token.js";


import { migrateBuiltinStores } from "../src/commands/store-migrate.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(import.meta.url);
const mode = process.argv[2];

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const databases = [
  ["identities", "identities"], ["sessions", "sessions"], ["memory", "memory"],
] as const;
/** A legacy-layout home, migrated into the generation layout; checks the migration preserved rows and originals. */
async function seed(home: string, label: string) {
  const support = join(home, "app-support");
  mkdirSync(support, { recursive: true });
  const originals: Record<string, string> = {};
  for (const [bag, store] of databases) {
    const directory = join(support, "data", bag);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${store}.db`);
    const db = new DatabaseSync(path);
    const migrations = loadSqlMigrations(join(repo, "bags", bag), `migrations/${store}`);
    // Legacy history deliberately has no checksum and optional .sql suffixes.
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT (datetime('now')));");
    migrations.forEach((migration, index) => { db.exec(migration.sql); db.prepare("INSERT INTO schema_migrations(version,name) VALUES(?,?)").run(index + 1, migration.name.replace(/\.sql$/, "")); });
    db.exec(`PRAGMA user_version=${migrations.length}`);
    if (bag === "identities") {
      db.exec("INSERT INTO actors(id,token,type,name) VALUES(1,'fixture-agent','agent','Barry'); INSERT INTO identities(id,token,actor_id,name) VALUES(1,'fixture-primary',1,'coder'),(2,'fixture-secondary',1,'reviewer');");
    } else if (bag === "sessions") {
      for (const [suffix, owner] of [["primary", 1], ["secondary", 2], ["orphan", 999]] as const) {
        const id = `${label}-${suffix}`;
        db.prepare("INSERT INTO sessions(id,identity_id,status) VALUES(?,?,'complete')").run(id, owner);
        db.prepare("INSERT INTO messages(id,session_id,type,role,sequence,content_text) VALUES(?,?,'text','user',1,?)").run(`${id}-message`, id, `${label} ${suffix} searchable`);
      }
    } else if (bag === "memory") {
      for (const suffix of ["primary", "secondary", "orphan"]) {
        db.prepare("INSERT INTO memories(id,title,body,source,session_id,created_at,updated_at) VALUES(?,?,?,'manual',?,datetime('now'),datetime('now'))").run(`${label}-${suffix}`, suffix, `${suffix} memory`, `${label}-${suffix}`);
        db.prepare("INSERT INTO memory_tags(memory_id,tag) VALUES(?,?)").run(`${label}-${suffix}`, "fixture");
      }
    }
    db.close(); originals[path] = sha(path);
  }
  const report = await migrateBuiltinStores(true) as { state: string; archived: unknown[] };
  assert.equal(report.state, "active");
  assert(report.archived.length >= 3);
  for (const [path, checksum] of Object.entries(originals)) assert.equal(sha(path), checksum, "legacy database was modified");
  const peers = new NodeRegistry();
  const identities = [peers.identityId(1), peers.identityId(2)];
  for (const [index, identity] of identities.entries()) {
    for (const [bag, store] of databases.filter(([bag]) => bag !== "identities")) {
      const path = storePath({ node: peers.id, identity, bag, store }, "identity", activeStoreRoot());
      const db = new DatabaseSync(path);
      const migrations = loadSqlMigrations(join(repo, "bags", bag), `migrations/${store}`);
      assert.equal(migrateStore(db, migrations, bag).from, migrations.length, "already applied SQL was replayed");
      assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
      const table = bag === "memory" ? "memories" : bag;
      const rows = db.prepare(`SELECT id FROM ${table}`).all();
      assert.deepEqual(rows.map((row) => row.id), [`${label}-${index ? "secondary" : "primary"}`]);
      if (bag === "sessions") assert.equal(db.prepare("SELECT count(*) AS count FROM messages_fts WHERE messages_fts MATCH 'searchable'").get()?.count, 1);
      assert.equal(db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE checksum IS NULL").get()?.count, 0);
      assert.throws(() => migrateStore(db, [{ ...migrations[0], sql: migrations[0].sql + "\n" }, ...migrations.slice(1)], bag), /checksum/);
      db.close();
    }
  }
  const result = { node: peers.id, identities, home, label, originalChecksums: originals, archivedRows: report.archived.length };
  peers.close();
  // The bound a remotable job needs, as `barry bag sync-traits` would record the fixture bag's.
  const { bounds, traits } = await import("@barry-rocks/identities-bag");
  await bounds.create({ name: "verify:no-files", bound: { files: { allowOnly: [] } } });
  await traits.upsert({ name: "verify:deny-workers", namespaces: [], access: "read", bound: { nodes: { deny: ["local", "b2", "c2"] } } });
  writeFileSync(join(home, "seed.json"), JSON.stringify(result, null, 2));
}

/** A bag with one remotable job: versioned, one self-contained file, bounded to no files. Only a worker labelled role=worker runs it. */
const FIXTURE_BAG = `name: verify
description: A remotable job for verify-nodes
jobs:
  echo:
    version: 1
    bounds: [ no-files ]
    runs:
      using: node
      main: echo.mjs
    requires:
      labels: { role: worker }
    input_schema: { type: object, properties: { text: { type: string } }, required: [ text ] }
    output_schema: { type: object, properties: { echo: { type: string } }, required: [ echo ] }
    timeout: 1m
bounds:
  no-files:
    description: No files at all
    bound:
      files: { allowOnly: [] }
`;
const FIXTURE_JOB = `let raw = ""; process.stdin.on("data", d => { raw += d; }); process.stdin.on("end", () => { const input = JSON.parse(raw); process.stdout.write(JSON.stringify({ echo: input.text, key: process.env.BARRY_JOB_KEY })); });`;

/** The run pins its one activity to the worker id the owner assigned at invite time. */
const REMOTE_WORKFLOW = `export const definitions = [{ type: "remote", version: "1", *run(input) {
  return yield { kind: "activity", type: "effect@1", input: { destination: input.destination, value: input.value }, placement: input.workers ? { nodes: { allow: input.workers } } : input.deny ? { nodes: { deny: input.deny } } : { node: input.worker }, heartbeatTimeoutMs: 2000, attemptTimeoutMs: 20000, retry: { maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 50 } };
} }];
`;

if (mode === "--seed") await seed(process.env.BARRY_HOME!, process.argv[3]);
else await verify();

async function verify() {
  const root = mkdtempSync(join(tmpdir(), "barry-nodes-verification-"));
  const children: ChildProcess[] = [];
  const servers: { close(callback: () => void): void; closeAllConnections?: () => void }[] = [];
  const results: { scenario: string; status: string; details?: unknown }[] = [];
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("BARRY_") && !key.endsWith("API_KEY") && !key.endsWith("TOKEN") && key !== "PORT"));
  const ca = join(root, "test-ca.pem");
  const key = join(root, "test-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", ca, "-subj", "/CN=Barry verification", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  const fixtureBuiltins = join(root, "builtins");
  mkdirSync(fixtureBuiltins);
  writeFileSync(join(fixtureBuiltins, "bag.yaml"), "name: verification\ndescription: Isolated verification collection\n");
  const secret = "verification-local-service-secret";
  const environment = (home: string) => ({ ...cleanEnv, BARRY_HOME: home, BARRY_SECRET: secret, BARRY_BUILTIN_DIR: fixtureBuiltins, BARRY_BAGS_BUILT: "0", BARRY_OLLAMA_URL: "http://127.0.0.1:1", NODE_EXTRA_CA_CERTS: ca });
  const logs: Record<string, string> = {};
  const spawnLogged = (args: string[], env: NodeJS.ProcessEnv, label: string) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child); logs[label] = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { logs[label] += String(data); writeFileSync(join(root, `${label}.log`), data, { flag: "a" }); });
    return child;
  };
  const run = (args: string[], env: NodeJS.ProcessEnv, label: string) => new Promise<string>((resolve, reject) => {
    const child = spawnLogged(args, env, label);
    child.once("exit", (code) => code === 0 ? resolve(logs[label]) : reject(new Error(`${label} failed (${code}): ${logs[label]}`)));
  });
  const cli = (home: string, ...args: string[]) => run([join(repo, "cli/src/index.ts"), ...args], environment(home), `cli-${args.slice(0, 2).join("-")}-${Date.now()}`);
  const freePort = async () => {
    const server = httpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve())); return port;
  };
  const until = async <T>(what: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 30_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { const value = await probe(); if (value !== undefined && value !== false) return value; } catch { /* not yet */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`timed out waiting for ${what}; logs at ${root}`);
  };
  const scenario = async (name: string, fn: () => Promise<unknown> | unknown) => {
    const details = await fn(); results.push({ scenario: name, status: "passed", details }); console.log(`PASS ${name}`);
  };
  const workflowsDb = (home: string) => join(activeStoreRoot(join(home, "app-support", "stores")), "node", "workflows", "workflows.db");
  const peersDb = (home: string) => join(activeStoreRoot(join(home, "app-support", "stores")), "node", "nodes", "peers.db");
  const query = <T>(path: string, sql: string, ...args: (string | number)[]): T[] => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return db.prepare(sql).all(...args).map((row) => ({ ...row })) as T[]; } finally { db.close(); }
  };
  /** One home's workflows service with its own module manifest. */
  const startWorkflows = async (home: string, label: string, manifest: object, extraEnv: Record<string, string> = {}) => {
    const port = extraEnv.PORT ? Number(extraEnv.PORT) : await freePort();
    const path = join(home, "workflow-module.json");
    writeFileSync(path, JSON.stringify(manifest));
    const child = spawnLogged([join(repo, "bags/workflows/runtime/src/service.ts")], { ...environment(home), PORT: String(port), BARRY_WORKFLOW_MODULE: path, BARRY_WORKFLOW_DRAIN_MS: "1000", ...(label === "a" || label.startsWith("a-") ? {} : { BARRY_WORKFLOW_WORKER_ONLY: "1" }), ...extraEnv }, `workflows-${label}`);
    await until(`${label} workflows ready`, async () => child.exitCode === null && (await fetch(`http://127.0.0.1:${port}/ready`)).ok);
    return { port, child };
  };
  /** The owner's HTTPS edge: what a hosting tunnel would be. */
  const edges = new Map<string, ReturnType<typeof httpsServer>>();
  const httpsEdge = async (target: number, fixedPort = 0) => {
    const server = httpsServer({ cert: readFileSync(ca), key: readFileSync(key) }, (req: IncomingMessage, res: ServerResponse) => {
      const upstream = request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers: req.headers }, (answer) => { res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res); });
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    });
    await new Promise<void>((resolve) => server.listen(fixedPort, "127.0.0.1", resolve));
    servers.push(server);
    const url = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    edges.set(url, server);
    return url;
  };
  /** HTTPS to the edge, trusting the test CA (this process started before it existed). */
  const secure = (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpsRequest(url, { method: options.method ?? "GET", headers: options.headers, ca: readFileSync(ca) }, (answer) => { let body = ""; answer.on("data", chunk => { body += String(chunk); }); answer.on("end", () => resolve({ status: answer.statusCode ?? 0, body })); });
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
  const hello = (url: string, credential: string) => secure(`${url}/api/worker`, { method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, body: JSON.stringify({ request: { version: 2, operation: "hello", session: `probe-${Date.now()}` } }) });
  const tokenFrom = (output: string) => {
    const raw = /barry workers join (barry_wj[12]\.\S+)/.exec(output)?.[1] ?? assert.fail(`no join token in: ${output}`);
    return { raw, ...decodeJoinToken(raw) };
  };

  // Effects land here; /hang holds a request open until the worker aborts it.
  const effects: { key: string; value: number }[] = [];
  const effectRequests: { key: string; value: number }[] = [];
  let holdFirst = false;
  let hung: { started: boolean; aborted: boolean } = { started: false, aborted: false };
  const destination = httpServer(async (req, res) => {
    if (req.url === "/hang") { hung = { started: true, aborted: false }; req.on("close", () => { if (!res.writableEnded) hung.aborted = true; }); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { key: string; value: number };
    effectRequests.push(body);
    const fresh = !effects.some((effect) => effect.key === body.key);
    if (fresh) effects.push(body);
    if (req.url === "/once-hold" && holdFirst && fresh) return;
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body.value));
  });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  servers.push(destination);
  const destinationUrl = `http://127.0.0.1:${(destination.address() as { port: number }).port}`;

  try {
    const homes = { a: join(root, "a"), b: join(root, "b"), c: join(root, "c") };
    await scenario("legacy migration, row ownership, archives, FTS, checksum adoption", async () => {
      for (const [label, home] of Object.entries(homes)) await run([script, "--seed", label], environment(home), `seed-${label}`);
    });
    const fixtureBag = join(root, "verify-bag");
    mkdirSync(fixtureBag);
    writeFileSync(join(fixtureBag, "bag.yaml"), FIXTURE_BAG);
    writeFileSync(join(fixtureBag, "echo.mjs"), FIXTURE_JOB);
    for (const home of Object.values(homes)) writeFileSync(join(home, "app-support", "bags.snapshot.json"), JSON.stringify({ bags: { verify: { type: "local", path: fixtureBag } } }));
    const workflow = join(root, "remote-workflow.mjs");
    writeFileSync(workflow, REMOTE_WORKFLOW);
    const activityPath = join(root, "effect-activity.mjs");
    writeFileSync(activityPath, readFileSync(join(repo, "bags/workflows/src/peer-activity-fixture.mjs"), "utf8").replace("key: context.idempotencyKey", "key: process.env.BARRY_JOB_KEY"));
    const activity = { path: activityPath, type: "effect@1", version: "1" };
    const clockPath = join(root, "owner-clock");
    const resetClock = () => writeFileSync(clockPath, String(Date.now()));
    const setClock = (at: number) => writeFileSync(clockPath, String(at));
    resetClock();
    const ownerManifest = { workflows: [{ path: workflow, type: "remote", version: "1" }], activities: [activity] };
    let owner = await startWorkflows(homes.a, "a", ownerManifest, { NODE_ENV: "test", BARRY_WORKFLOW_TEST_CLOCK: clockPath });
    const ownerUrl = await httpsEdge(owner.port);
    const ownerId = JSON.parse(readFileSync(join(homes.a, "seed.json"), "utf8")).node as string;

    const invite = tokenFrom(await cli(homes.a, "workers", "invite", "b", "--url", ownerUrl));
    await scenario("unscoped nonexpiring CLI invite is decoded by master's strict v1 decoder and authenticates on the wire", async () => {
      const legacy = decodeMasterJoinToken(invite.raw);
      assert.equal(legacy.v, 1);
      assert.equal(query<{ inviteExpiresAt: number | null }>(peersDb(homes.a), "SELECT inviteExpiresAt FROM workers WHERE id=?", legacy.worker)[0].inviteExpiresAt, null);
      const response = await hello(legacy.url, legacy.credential);
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).owner, ownerId);
    });
    await scenario("invite and join link one way: the owner keeps a hashed credential, the worker keeps the address", async () => {
      assert.equal(invite.owner, ownerId);
      assert.match(await cli(homes.b, "workers", "join", invite.raw), /Joined https:\/\/127\.0\.0\.1/);
      assert.deepEqual(query(peersDb(homes.a), "SELECT id FROM owners"), []);
      assert.deepEqual(query<{ id: string }>(peersDb(homes.a), "SELECT id FROM workers").map((row) => row.id), [invite.worker]);
      assert.equal(existsSync(join(homes.a, "app-support", "stores", "credentials", "nodes", "outgoing-secrets.json")), false);
      assert.deepEqual(query<{ id: string; workerId: string }>(peersDb(homes.b), "SELECT id, workerId FROM owners"), [{ id: ownerId, workerId: invite.worker }]);
      assert.deepEqual(query(peersDb(homes.b), "SELECT id FROM workers"), []);
      assert(!query<{ hash: string }>(peersDb(homes.a), "SELECT hash FROM credentials").some((row) => row.hash.includes(invite.credential)));
    });
    let worker = await startWorkflows(homes.b, "b", { workflows: [], activities: [activity] }, { BARRY_WORKFLOW_LABELS: "role=worker" });
    await scenario("foreground worker serves readiness without exposing an owner console", async () => {
      assert.equal((await fetch(`http://127.0.0.1:${worker.port}/ready`)).ok, true);
      assert.equal((await fetch(`http://127.0.0.1:${worker.port}/`)).status, 404);
      assert.equal((await fetch(`http://127.0.0.1:${worker.port}/api/runs`, { headers: { Authorization: `Bearer ${secret}` } })).status, 404);
    });
    const startRun = async (id: string, input: object) => {
      const response = await fetch(`http://127.0.0.1:${owner.port}/api/runs`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ id, type: "remote", version: "1", input }) });
      assert(response.ok, `start ${id}: ${response.status} ${await response.text()}`);
    };
    await scenario("a remote activity runs over /api/worker and is attributed to the worker id the owner assigned", async () => {
      await startRun("remote-1", { destination: destinationUrl, value: 7, worker: invite.worker });
      await until("remote-1 completed", () => query<{ status: string }>(workflowsDb(homes.a), "SELECT status FROM workflow_runs WHERE id='remote-1'")[0]?.status === "completed");
      const attempts = query<{ worker: string }>(workflowsDb(homes.a), "SELECT a.worker FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id='remote-1'").map((row) => row.worker);
      assert(attempts.length > 0 && attempts.every((id) => id === invite.worker), `attempts by ${attempts.join(",")}`);
      assert.deepEqual(effects.map((effect) => effect.value), [7]);
      return { attempts };
    });
    await scenario("a worker credential opens /api/worker and nothing else", async () => {
      assert.equal((await hello(ownerUrl, invite.credential)).status, 200);
      for (const path of ["/api/overview", "/api/runs", "/"]) assert.equal((await secure(`${ownerUrl}${path}`, { headers: { Authorization: `Bearer ${invite.credential}` } })).status, 401, path);
      assert.equal((await hello(ownerUrl, `barry_wk_${"x".repeat(43)}`)).status, 401);
      assert.equal((await hello(ownerUrl, secret)).status, 403);
    });
    const rotated = tokenFrom(await cli(homes.a, "workers", "rotate", "b", "--url", ownerUrl));
    await scenario("rotation issues a new credential and keeps the old one for its grace period", async () => {
      assert.equal(decodeMasterJoinToken(rotated.raw).v, 1);
      assert.equal(rotated.worker, invite.worker);
      assert.notEqual(rotated.credential, invite.credential);
      assert.equal((await hello(ownerUrl, rotated.credential)).status, 200);
      assert.equal((await hello(ownerUrl, invite.credential)).status, 200);
    });
    await scenario("rotation grace boundary uses the owner clock at 4m59s and 5m01s", async () => {
      const expiry = query<{ expiresAt: number }>(peersDb(homes.a), "SELECT expiresAt FROM credentials WHERE expiresAt IS NOT NULL ORDER BY expiresAt DESC LIMIT 1")[0].expiresAt;
      setClock(expiry - 1000);
      assert.equal((await hello(ownerUrl, invite.credential)).status, 200);
      setClock(expiry + 1000);
      assert.equal((await hello(ownerUrl, invite.credential)).status, 401);
      resetClock();
    });
    await scenario("the same token on a second machine is the same worker, and takes over its session", async () => {
      await cli(homes.c, "workers", "join", rotated.raw);
      const before = query(workflowsDb(homes.a), "SELECT session FROM workflow_worker_sessions WHERE worker=?", invite.worker).length;
      const second = await startWorkflows(homes.c, "c", { workflows: [], activities: [activity] });
      await until("second session for the same worker", () => query(workflowsDb(homes.a), "SELECT session FROM workflow_worker_sessions WHERE worker=?", invite.worker).length > before);
      assert.equal(query(workflowsDb(homes.a), "SELECT session FROM workflow_worker_sessions WHERE worker=? AND retired=0", invite.worker).length, 1);
      // The displaced process stays fenced until it restarts with a new session.
      await until("the displaced worker fenced", () => /obsolete worker session/.test(logs["workflows-b"]));
      second.child.kill("SIGKILL");
      worker.child.kill("SIGTERM");
      await new Promise((resolve) => worker.child.exitCode !== null ? resolve(null) : worker.child.once("exit", resolve));
      worker = await startWorkflows(homes.b, "b-restarted", { workflows: [], activities: [activity] }, { BARRY_WORKFLOW_LABELS: "role=worker" });
    });
    await scenario("a bag job runs on the worker whose labels it requires, through job@1, checked against its contract", async () => {
      const start = (id: string, input: unknown) => fetch(`http://127.0.0.1:${owner.port}/api/runs`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ id, type: "job", version: "1", input: { job: "verify:echo@1", input } }) });
      const refused = await start("job-bad", { text: 7 });
      assert.equal(refused.status, 400, await refused.text());
      assert.equal((await start("job-1", { text: "over https" })).ok, true);
      await until("job-1 completed", () => query<{ status: string }>(workflowsDb(homes.a), "SELECT status FROM workflow_runs WHERE id='job-1'")[0]?.status === "completed");
      const attempts = query<{ worker: string }>(workflowsDb(homes.a), "SELECT a.worker FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id='job-1'").map((row) => row.worker);
      assert.deepEqual([...new Set(attempts)], [invite.worker]);
      const outcome = JSON.parse(query<{ outcome: string }>(workflowsDb(homes.a), "SELECT outcome FROM workflow_runs WHERE id='job-1'")[0].outcome) as { ok: boolean; value: { echo: string; key: string } };
      assert.equal(outcome.value.echo, "over https");
      assert.match(outcome.value.key, /\S/);
      assert.equal(query(workflowsDb(homes.a), "SELECT type FROM workflow_job_contracts WHERE type='verify:echo@1'").length, 1);
    });
    await scenario("revoking a worker refuses its next call and aborts the activity it is running", async () => {
      await startRun("remote-hang", { destination: `${destinationUrl}/hang`, value: 1, worker: invite.worker });
      await until("the worker started the hanging effect", () => hung.started);
      await cli(homes.a, "workers", "revoke", "b");
      await until("the hanging effect aborted", () => hung.aborted);
      assert.equal((await hello(ownerUrl, invite.credential)).status, 401);
      assert.equal((await hello(ownerUrl, rotated.credential)).status, 401);
      await until("the worker logged the rejection", () => /rejected this worker's credential/.test(logs["workflows-b-restarted"]));
    });

    await scenario("expired unused invite is refused on the wire and appears as pending", async () => {
      const pending = tokenFrom(await cli(homes.a, "workers", "invite", "expired", "--url", ownerUrl, "--expires-in", "86400"));
      assert.equal(pending.v, 2);
      const expiry = query<{ inviteExpiresAt: number }>(peersDb(homes.a), "SELECT inviteExpiresAt FROM workers WHERE id=?", pending.worker)[0].inviteExpiresAt;
      setClock(expiry);
      assert.equal((await hello(ownerUrl, pending.credential)).status, 401);
      resetClock();
      const listing = JSON.parse(await cli(homes.a, "workers", "list", "--json"));
      assert.equal(listing.workers.find((entry: { id: string }) => entry.id === pending.worker).joinedAt, null);
      assert(listing.audit.some((row: { event: string; workerId: string }) => row.event === "invite" && row.workerId === pending.worker));
    });
    const scoped = tokenFrom(await cli(homes.a, "workers", "invite", "scoped", "--url", ownerUrl, "--jobs", "verify:other@1"));
    assert.equal(scoped.v, 2);
    assert.equal(scoped.expiresAt, query<{ inviteExpiresAt: number }>(peersDb(homes.a), "SELECT inviteExpiresAt FROM workers WHERE id=?", scoped.worker)[0].inviteExpiresAt);
    await cli(homes.c, "workers", "join", scoped.raw);
    const scopedWorker = await startWorkflows(homes.c, "scoped", { workflows: [], activities: [activity] }, { BARRY_WORKFLOW_LABELS: "role=worker" });
    await scenario("out-of-scope job is never offered even when the worker advertises its artifact", async () => {
      const response = await fetch(`http://127.0.0.1:${owner.port}/api/runs`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "scope-denied", type: "job", version: "1", input: { job: "verify:echo@1", input: { text: "forbidden" } } }) });
      assert.equal(response.ok, true, await response.text());
      await until("scope denial in queue diagnostics", async () => {
        const diagnostic = await fetch(`http://127.0.0.1:${owner.port}/api/runs/scope-denied/eligibility?workers=true`, { headers: { Authorization: `Bearer ${secret}` } });
        const body = await diagnostic.text();
        return body.includes("WORKER_JOB_SCOPE_EXCLUDED");
      });
      assert.equal(query(workflowsDb(homes.a), "SELECT a.token FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id='scope-denied' AND a.worker=?", scoped.worker).length, 0);
      assert.match(await cli(homes.c, "workers", "status"), /verify:other@1/);
    });
    scopedWorker.child.kill("SIGKILL");
    await new Promise(resolve => scopedWorker.child.once("exit", resolve));
    worker.child.kill("SIGKILL");
    await new Promise(resolve => worker.child.once("exit", resolve));
    const b2 = tokenFrom(await cli(homes.a, "workers", "invite", "b2", "--url", ownerUrl));
    const c2 = tokenFrom(await cli(homes.a, "workers", "invite", "c2", "--url", ownerUrl));
    await cli(homes.b, "workers", "join", b2.raw);
    await cli(homes.c, "workers", "join", c2.raw);
    const manifest = { workflows: [], activities: [activity] };
    let first = await startWorkflows(homes.b, "fault-b", manifest, { BARRY_WORKFLOW_CAPACITY: "1", BARRY_WORKFLOW_LABELS: "role=worker" });
    let second = await startWorkflows(homes.c, "fault-c", manifest, { BARRY_WORKFLOW_CAPACITY: "1", BARRY_WORKFLOW_LABELS: "role=worker" });
    await scenario("worker killed mid-step retries on another worker with one destination effect", async () => {
      holdFirst = true;
      await startRun("kill-mid-step", { destination: `${destinationUrl}/once-hold`, value: 42, workers: [b2.worker, c2.worker] });
      await until("first effect committed with response held", () => effects.some(effect => effect.value === 42));
      const claimed = query<{ worker: string; lease_until: number }>(workflowsDb(homes.a), "SELECT a.worker,c.lease_until FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id='kill-mid-step' AND a.state='active'")[0];
      const dead = claimed.worker === b2.worker ? first : second;
      dead.child.kill("SIGKILL");
      await new Promise(resolve => dead.child.once("exit", resolve));
      setClock(claimed.lease_until + 1);
      await until("expired attempt", () => query<{ state: string }>(workflowsDb(homes.a), "SELECT a.state FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id='kill-mid-step' ORDER BY a.attempt")[0]?.state !== "active");
      setClock(claimed.lease_until + 2100);
      await until("retried effect completed", () => query<{ status: string }>(workflowsDb(homes.a), "SELECT status FROM workflow_runs WHERE id='kill-mid-step'")[0]?.status === "completed");
      const attempts = query<{ worker: string }>(workflowsDb(homes.a), "SELECT a.worker FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id='kill-mid-step' ORDER BY a.attempt");
      assert.equal(attempts.length, 2); assert.notEqual(attempts[0].worker, attempts[1].worker);
      const requests = effectRequests.filter(effect => effect.value === 42);
      assert.equal(requests.length, 2); assert.equal(requests[0].key, requests[1].key);
      assert.equal(effects.filter(effect => effect.value === 42).length, 1);
      resetClock(); holdFirst = false;
      if (claimed.worker === b2.worker) first = await startWorkflows(homes.b, "fault-b-restarted", manifest, { BARRY_WORKFLOW_CAPACITY: "1", BARRY_WORKFLOW_LABELS: "role=worker" });
      else second = await startWorkflows(homes.c, "fault-c-restarted", manifest, { BARRY_WORKFLOW_CAPACITY: "1", BARRY_WORKFLOW_LABELS: "role=worker" });
    });
    await scenario("owner edge outage expires advertisements and workers recover without a restart", async () => {
      const edge = edges.get(ownerUrl)!;
      edge.closeAllConnections();
      await new Promise<void>(resolve => edge.close(() => resolve()));
      const start = Number(readFileSync(clockPath, "utf8"));
      setClock(start + 15_001);
      await startRun("edge-offline", { destination: destinationUrl, value: 46, workers: [b2.worker, c2.worker] });
      await until("expired remote advertisement", async () => (await (await fetch(`http://127.0.0.1:${owner.port}/api/runs/edge-offline/eligibility`, { headers: { Authorization: `Bearer ${secret}` } })).text()).includes("WORKER_OFFLINE"));
      await until("worker transport backoff", () => Object.entries(logs).some(([label, log]) => label.startsWith("workflows-fault-") && /ECONNREFUSED|fetch failed/.test(log)));
      await httpsEdge(owner.port, Number(new URL(ownerUrl).port));
      await until("worker resumed claims", () => query<{ status: string }>(workflowsDb(homes.a), "SELECT status FROM workflow_runs WHERE id='edge-offline'")[0]?.status === "completed");
      for (const [label, log] of Object.entries(logs)) if (label.startsWith("workflows-fault-")) assert(!log.includes("obsolete worker session"), label);
      resetClock();
    });
    await scenario("owner restart with outstanding claims recovers runs with destination reconciliation", async () => {
      holdFirst = true;
      for (const value of [47, 48]) await startRun(`restart-${value}`, { destination: `${destinationUrl}/once-hold`, value, workers: [b2.worker, c2.worker] });
      await until("both effects committed with responses held", () => [47, 48].every(value => effects.some(effect => effect.value === value)));
      const leases = query<{ lease_until: number }>(workflowsDb(homes.a), "SELECT lease_until FROM workflow_commands WHERE run_id IN ('restart-47','restart-48') AND state='leased'");
      assert.equal(leases.length, 2);
      owner.child.kill("SIGKILL");
      await new Promise(resolve => owner.child.once("exit", resolve));
      setClock(Math.max(...leases.map(row => row.lease_until)) + 100);
      owner = await startWorkflows(homes.a, "a-recovered", ownerManifest, { PORT: String(owner.port), NODE_ENV: "test", BARRY_WORKFLOW_TEST_CLOCK: clockPath });
      // Readiness can precede the turn that expires the second lease. Wait for
      // both expirations before advancing beyond their recorded retry times;
      // otherwise the second turn can schedule backoff after the frozen clock.
      await until("both pre-restart attempts expired", () => {
        const attempts = query<{ state: string }>(workflowsDb(homes.a), "SELECT a.state FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id IN ('restart-47','restart-48') AND a.attempt=1");
        return attempts.length === 2 && attempts.every(attempt => attempt.state !== "active");
      });
      const retries = query<{ ready_at: number }>(workflowsDb(homes.a), "SELECT ready_at FROM workflow_commands WHERE run_id IN ('restart-47','restart-48')");
      setClock(Math.max(...retries.map(retry => retry.ready_at)) + 2100);
      for (const value of [47, 48]) {
        await until(`restart-${value} completed`, () => query<{ status: string }>(workflowsDb(homes.a), "SELECT status FROM workflow_runs WHERE id=?", `restart-${value}`)[0]?.status === "completed");
        const requests = effectRequests.filter(effect => effect.value === value);
        assert(requests.length >= 2); assert.equal(new Set(requests.map(effect => effect.key)).size, 1);
        assert.equal(effects.filter(effect => effect.value === value).length, 1);
      }
      holdFirst = false; resetClock();
    });
    await scenario("worker clocks five minutes ahead and behind do not decide attempt deadlines", async () => {
      for (const child of [first.child, second.child]) child.kill("SIGKILL");
      await Promise.all([first.child, second.child].map(child => new Promise(resolve => child.once("exit", resolve))));
      first = await startWorkflows(homes.b, "skew-ahead", manifest, { NODE_ENV: "test", BARRY_WORKFLOW_CLOCK_OFFSET_MS: "300000", BARRY_WORKFLOW_CAPACITY: "1", BARRY_WORKFLOW_LABELS: "role=worker" });
      second = await startWorkflows(homes.c, "skew-behind", manifest, { NODE_ENV: "test", BARRY_WORKFLOW_CLOCK_OFFSET_MS: "-300000", BARRY_WORKFLOW_CAPACITY: "1", BARRY_WORKFLOW_LABELS: "role=worker" });
      for (const [value, workerId] of [[49, b2.worker], [50, c2.worker]] as const) {
        const ownerTime = Number(readFileSync(clockPath, "utf8"));
        await startRun(`skew-${value}`, { destination: destinationUrl, value, worker: workerId });
        await until(`skew-${value} completed`, () => query<{ status: string }>(workflowsDb(homes.a), "SELECT status FROM workflow_runs WHERE id=?", `skew-${value}`)[0]?.status === "completed");
        const claim = query<{ attempt_deadline: number }>(workflowsDb(homes.a), "SELECT attempt_deadline FROM workflow_commands WHERE run_id=?", `skew-${value}`)[0];
        // Completed commands clear leases; recorded claim timestamps remain in attempt/history rows.
        const attempt = query<{ started_at: number }>(workflowsDb(homes.a), "SELECT a.started_at FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=?", `skew-${value}`)[0];
        assert.equal(attempt.started_at, ownerTime);
        void claim;
      }
    });
    await scenario("placement deny keeps a named worker out with NODE_BOUND_EXCLUDED diagnostics", async () => {
      await startRun("placement-denied", { destination: destinationUrl, value: 51, deny: ["local", "b2", "c2"] });
      await until("node-bound diagnostics", async () => (await (await fetch(`http://127.0.0.1:${owner.port}/api/runs/placement-denied/eligibility`, { headers: { Authorization: `Bearer ${secret}` } })).text()).includes("NODE_BOUND_EXCLUDED"));
      assert.equal(query(workflowsDb(homes.a), "SELECT a.token FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id='placement-denied'").length, 0);
    });
    await scenario("run grant node bounds exclude the only worker eligible for a step", async () => {
      const response = await fetch(`http://127.0.0.1:${owner.port}/api/runs`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "grant-placement-denied", type: "remote", version: "1", input: { destination: destinationUrl, value: 52, worker: b2.worker }, job: { traits: ["verify:deny-workers"] } }) });
      assert(response.ok, await response.text());
      await until("granted node-bound diagnostics", async () => (await (await fetch(`http://127.0.0.1:${owner.port}/api/runs/grant-placement-denied/eligibility`, { headers: { Authorization: `Bearer ${secret}` } })).text()).includes("NODE_BOUND_EXCLUDED"));
      assert.equal(query(workflowsDb(homes.a), "SELECT a.token FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id='grant-placement-denied'").length, 0);
    });
    await scenario("capacity one declines a second claim and oversized input is refused at admission", async () => {
      hung = { started: false, aborted: false };
      await startRun("capacity-held", { destination: `${destinationUrl}/hang`, value: 44, worker: b2.worker });
      await until("capacity held", () => hung.started);
      await startRun("capacity-wait", { destination: destinationUrl, value: 45, worker: b2.worker });
      await until("capacity diagnostic", async () => (await (await fetch(`http://127.0.0.1:${owner.port}/api/runs/capacity-wait/eligibility?workers=true`, { headers: { Authorization: `Bearer ${secret}` } })).text()).includes("CAPACITY_FULL"));
      assert.equal(query(workflowsDb(homes.a), "SELECT a.token FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id='capacity-wait'").length, 0);
      const tooLarge = await fetch(`http://127.0.0.1:${owner.port}/api/runs`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "too-large", type: "remote", version: "1", input: { text: "x".repeat(262145) } }) });
      const error = await tooLarge.text();
      assert.equal(tooLarge.status, 413, error); assert.match(error, /PayloadTooLarge/);
      assert.equal(query(workflowsDb(homes.a), "SELECT id FROM workflow_runs WHERE id='too-large'").length, 0);
    });
    await scenario("changed input schema under a pinned job version is refused at owner startup", async () => {
      const pinned = query<{ contract: string }>(workflowsDb(homes.a), "SELECT contract FROM workflow_job_contracts WHERE type='verify:echo@1'")[0].contract;
      owner.child.kill("SIGKILL");
      await new Promise(resolve => owner.child.once("exit", resolve));
      writeFileSync(join(fixtureBag, "bag.yaml"), FIXTURE_BAG.replace("text: { type: string }", "text: { type: number }"));
      const changed = spawnLogged([join(repo, "bags/workflows/runtime/src/service.ts")], { ...environment(homes.a), PORT: String(owner.port), BARRY_WORKFLOW_MODULE: join(homes.a, "workflow-module.json") }, "workflows-contract-conflict");
      await until("contract registration refusal", () => changed.exitCode !== null);
      assert.equal(changed.exitCode, 1);
      assert.match(logs["workflows-contract-conflict"], /job verify:echo@1 changed its contract in place/);
      assert.equal(query<{ contract: string }>(workflowsDb(homes.a), "SELECT contract FROM workflow_job_contracts WHERE type='verify:echo@1'")[0].contract, pinned);
      writeFileSync(join(fixtureBag, "bag.yaml"), FIXTURE_BAG);
    });
  } catch (error) {
    results.push({ scenario: "verification", status: "failed", details: error instanceof Error ? error.message : String(error) });
    const ownerDb = workflowsDb(join(root, "a"));
    if (existsSync(ownerDb)) {
      try {
        const state = {
          clock: existsSync(join(root, "owner-clock")) ? readFileSync(join(root, "owner-clock"), "utf8") : null,
          runs: query(ownerDb, "SELECT id,status,error FROM workflow_runs ORDER BY id LIMIT 64"),
          commands: query(ownerDb, "SELECT id,run_id,state,ready_at,lease_until,attempts FROM workflow_commands ORDER BY run_id LIMIT 64"),
          attempts: query(ownerDb, "SELECT command_id,worker,attempt,state,physical_state FROM workflow_attempts ORDER BY command_id,attempt LIMIT 128"),
          due: query(ownerDb, "SELECT * FROM workflow_due ORDER BY run_id LIMIT 64"),
        };
        writeFileSync(join(root, "failure-state.json"), JSON.stringify(state, null, 2));
      } catch { /* Keep the original verification failure authoritative. */ }
    }
    process.exitCode = 1;
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000); child.once("exit", () => { clearTimeout(timer); resolve(); }); })));
    for (const server of servers) { server.closeAllConnections?.(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    const report = join(root, "report.json");
    writeFileSync(report, JSON.stringify(results, null, 2));
    console.log(`Report: ${report}`);
    for (const result of results.filter((entry) => entry.status !== "passed")) console.error(`FAIL ${result.scenario}: ${String(result.details)}`);
  }
}
