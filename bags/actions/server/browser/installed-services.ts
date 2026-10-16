import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { z } from "zod";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const acceptedSchema = z.object({ run_id: z.string(), work_id: z.string(), workflow_id: z.string(), idempotency_key: z.string(), created: z.boolean() });
export type InstalledAcceptedWork = z.infer<typeof acceptedSchema>;
type Child = { process: ReturnType<typeof spawn>; done: boolean; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; stdout: string; stderr: string; termination: "exit" | "SIGTERM" };

/** All services, admission resolution, bounds, credentials and CLI execution are
 * production paths. Setup only seeds a disposable installation's real records. */
export async function installedBrowserServices() {
  const options = { managedEntry: true };
  const root = mkdtempSync(join(tmpdir(), "installed-identity-work-")), home = join(root, "home"), action = join(root, "fixture", "actions", "probe"), secretDirectory = join(root, "identity-secrets");
  for (const path of [action, secretDirectory, join(home, "config"), join(home, "app-support")]) mkdirSync(path, { recursive: true });
  const secret = "installed-identity-hop-fixture", selectedSecret = "selected-identity-value-fixture", actorKey = "installed-identity-actor-key-longer-than-thirty-two-bytes";
  const keyRing = join(root, "delegation-keys.json"), snapshot = join(root, "bags.json"), resources = join(root, "script-resources.json"), boundsFile = join(root, "work-bounds.json"), projections = join(root, "projections.json");
  const configPath = join(home, "config", "barry.yaml");
  const configuration = { secrets: { BARRY_SECRET: { in: ".env" }, BARRY_WORKFLOW_ACTOR_KEY: { in: ".env" }, SCRIPT_KEY: { in: ".env" } }, services: {} as Record<string, { env: unknown }> };
  writeFileSync(configPath, JSON.stringify(configuration));
  writeFileSync(join(home, "app-support", "env"), `BARRY_SECRET=${secret}\nBARRY_WORKFLOW_ACTOR_KEY=${actorKey}\nSCRIPT_KEY=wrong-installation\n`, { mode: 0o600 });
  const writeIdentitySecret = (present: boolean) => writeFileSync(join(secretDirectory, ".env"), `${present ? `SCRIPT_KEY=${selectedSecret}\n` : ""}NOTIFIER_ONLY=undeclared-notifier-fixture\n`, { mode: 0o600 });
  writeIdentitySecret(true);
  writeFileSync(join(root, "fixture", "bag.yaml"), JSON.stringify({ name: "fixtureinstalled", description: "Disposable installed identity script" }));
  writeFileSync(join(action, "action.yaml"), JSON.stringify({ name: "probe", description: "Prove selected identity credentials and native Stop", context: "none", run: "main.sh", timeout: 60,
    secrets: ["SCRIPT_KEY"], input_schema: { type: "object", properties: { mode: { enum: ["finish", "wait"] } }, required: ["mode"], additionalProperties: false },
    output_schema: { type: "object", properties: { credential_digest: { type: "string" }, id: { type: "string" }, label: { type: "string" } }, required: ["credential_digest", "id", "label"], additionalProperties: false } }));
  writeFileSync(join(action, "main.sh"), [
    'test -n "$SCRIPT_KEY" || exit 11', 'test -z "${NOTIFIER_ONLY-}${BARRY_STATUS_NOTIFY-}${BARRY_SECRET-}" || exit 12',
    'proof=$(printf "%s" "$SCRIPT_KEY" | /usr/bin/shasum -a 256) || exit 13',
    'printf once >> "effects-$BARRY_ACTION_RUN_ID"',
    'printf "script-log-%s" "$BARRY_ACTION_RUN_ID" >&2',
    'case "$BARRY_ACTION_INPUTS" in *wait*) trap "" TERM; printf "%s" "$$" > "ready-$BARRY_ACTION_RUN_ID"; i=0; while [ "$i" -lt 600 ]; do /bin/sleep 0.1; i=$((i+1)); done ;; esac',
    'printf \'{"credential_digest":"%s","id":"%s","label":"<img src=x onerror=alert(1)>"}\' "${proof%% *}" "$BARRY_ACTION_RUN_ID"',
  ].join("\n"));
  const registry = { bags: { workflows: { type: "local", path: join(repo, "bags/workflows") }, ...(options.managedEntry ? { sessions: { type: "local", path: join(repo, "bags/sessions") }, actions: { type: "local", path: join(repo, "bags/actions") } } : {}), bash: { type: "local", path: join(repo, "bags/bash") }, fixtureinstalled: { type: "local", path: join(root, "fixture") } } };
  writeFileSync(snapshot, JSON.stringify(registry));
  // executeService keeps the installation location, but deliberately drops registry overrides.
  if (options.managedEntry) writeFileSync(join(home, "app-support", "bags.snapshot.json"), JSON.stringify(registry));
  writeFileSync(resources, JSON.stringify({ version: 1, scripts: [{ reference: "fixtureinstalled:probe", resource_policy: "closed", allowed_roots: [action], entry: "main.sh",
    files: ["main.sh", "action.yaml"].map(path => ({ path, source: join(action, path) })), arguments: [{ index: 0, path: "main.sh", format: "path" }] }] }));
  writeFileSync(keyRing, JSON.stringify({ "workflows.sessions.identity": [{ id: "fixture", secret: "installed-identity-admission-delegation-key", not_before: Date.now() - 1000, not_after: Date.now() + 3600000 }] }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: tmpdir(), BARRY_HOME: home, BARRY_DIR: repo, BARRY_BUILTIN_DIR: join(repo, "bags"), BARRY_SECRET: secret,
    BARRY_BAGS_SNAPSHOT: snapshot, BARRY_WORKFLOW_DELEGATION_KEYS: keyRing, BARRY_WORKFLOW_SCRIPT_RESOURCES: resources, BARRY_WORKFLOW_ACTION_PROJECTIONS: projections,
    BARRY_WORKFLOW_POLICY: boundsFile, SCRIPT_KEY: "wrong-ambient", NOTIFIER_ONLY: "wrong-ambient-notifier", LC_ALL: "C" };
  const children: Child[] = [];
  const launch = (args: string[], extra: NodeJS.ProcessEnv = {}, cwd = join(repo, "bags/sessions/api")) => {
    const child: Child = { process: spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] }), done: false, closed: Promise.resolve({ code: null, signal: null }), stdout: "", stderr: "", termination: "exit" };
    child.process.stdout!.on("data", bytes => { child.stdout = (child.stdout + String(bytes)).slice(-120000); });
    child.process.stderr!.on("data", bytes => { child.stderr = (child.stderr + String(bytes)).slice(-120000); });
    child.closed = new Promise(resolve => child.process.once("close", (code, signal) => { child.done = true; resolve({ code, signal }); })); children.push(child); return child;
  };
  const storeSetup = async (command: { command: "initialize"; metadata: Record<string, unknown> } | { command: "set-bash"; allowed: boolean } | { command: "prepare-services"; runtimePort: number; apiPort: number; webPort: number } | { command: "seed-sessions" | "read-only" | "end-session" | "session-state" | "rebind-session" }) => {
    const child = launch(["--import", "tsx", join(repo, "cli/test/fixtures/identity-work-store.ts"), JSON.stringify(command)], { VITEST: "true" }, join(repo, "cli"));
    await child.closed;
    assert.equal(child.process.exitCode, 0, child.stderr);
    return child.stdout;
  };
  const serviceReady = async (child: Child, name: string, ready: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (child.done) throw new Error(`${name} exited before readiness: ${child.stderr || child.stdout}`);
      if (await ready()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`${name} did not become ready: ${child.stderr || child.stdout}`);
  };
  const stopChild = async (child: Child) => {
    if (child.done) return;
    child.process.kill("SIGTERM");
    try { const deadline = Date.now() + 25000; while (!child.done && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(child.done, true, "Service shutdown exceeded25s"); }
    catch (error) { child.process.kill("SIGKILL"); await child.closed; throw error; }
    assert.deepEqual(await child.closed, child.termination === "SIGTERM" ? { code: null, signal: "SIGTERM" } : { code: 0, signal: null }, child.stderr);
  };
  let relay: ReturnType<typeof createServer> | undefined;
  const close = async () => {
    const errors: unknown[] = [];
    for (const child of [...children].reverse()) try { await stopChild(child); } catch (error) { errors.push(error); }
    if (relay) await new Promise<void>(done => { relay!.closeAllConnections(); relay!.close(() => done()); });
    if (!errors.length) rmSync(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, `Fixture cleanup failed; retained diagnostics at ${root}`);
  };
  try {
    const metadata = { bags: ["workflows", "bash", "fixtureinstalled"],
      secrets: { SCRIPT_KEY: { reference: { in: ".env" }, directory: secretDirectory }, NOTIFIER_ONLY: { reference: { in: ".env" }, directory: secretDirectory } },
      status_notify: { tool: "fixture-notifier:send", target: "fixture" } };
    const initialized = z.object({ identity: z.string(), installation: z.string(), projection: z.string() }).parse(JSON.parse(await storeSetup({ command: "initialize", metadata })));
    writeFileSync(boundsFile, JSON.stringify({ [initialized.identity]: { types: ["action-script"], operations: ["start", "get", "list", "cancel"], payloadRead: true } }));
    writeFileSync(projections, JSON.stringify({ version: 1, routes: [{ owner: { kind: "identity", identity_id: initialized.identity }, path: initialized.projection }] }));
    const reservePort = async () => { const socket = createServer(); await new Promise<void>(done => socket.listen(0, "127.0.0.1", done)); const port = (socket.address() as { port: number }).port; await new Promise<void>(done => socket.close(() => done())); return port; };
    const runtimePort = await reservePort(), apiPort = await reservePort(), webPort = await reservePort(), runtimeUrl = `http://127.0.0.1:${runtimePort}`, apiUrl = `http://127.0.0.1:${apiPort}`, webUrl = `http://127.0.0.1:${webPort}`;
    const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
    const entryArgs = (service: string) => ["--import", "tsx", join(repo, "cli/src/services/entry.ts"), join(home, "app-support"), service];
    const managedAmbient = Object.fromEntries(["BARRY_WORKFLOW_DELEGATION_KEYS", "BARRY_WORKFLOW_SCRIPT_RESOURCES", "BARRY_WORKFLOW_ACTION_PROJECTIONS", "BARRY_WORKFLOW_POLICY"].map(name => [name, join(root, "absent-ambient", name)]));
    if (options.managedEntry) {
      configuration.services = {
        "workflows.runtime": { env: [`BARRY_WORKFLOW_DELEGATION_KEYS=${keyRing}`, `BARRY_WORKFLOW_SCRIPT_RESOURCES=${resources}`, `BARRY_WORKFLOW_ACTION_PROJECTIONS=${projections}`, `BARRY_WORKFLOW_POLICY=${boundsFile}`] },
        "sessions.api": { env: [`BARRY_WORKFLOW_DELEGATION_KEYS=${keyRing}`] },
      };
      writeFileSync(configPath, JSON.stringify(configuration));
      await storeSetup({ command: "prepare-services", runtimePort, apiPort, webPort });
    }
    const runtime = options.managedEntry ? launch(entryArgs("workflows.runtime"), managedAmbient) : launch(["--import", "tsx", join(repo, "bags/workflows/runtime/src/service.ts")], { PORT: String(runtimePort) });
    await serviceReady(runtime, "workflows.runtime", () => (runtime.stdout + runtime.stderr).includes("runtime ready"));
    assert.equal((await fetch(runtimeUrl + "/ready")).status, 200);
    const relayState: { dropSubmissionReply: boolean; submissions: number; dropStopReply: boolean; stopBodies: string[]; stopReplies: unknown[] } = { dropSubmissionReply: false, submissions: 0, dropStopReply: false, stopBodies: [], stopReplies: [] };
    relay = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const bytes of req) chunks.push(Buffer.from(bytes));
        const response = await fetch(new URL(req.url!, runtimeUrl), { method: req.method, headers: { Authorization: req.headers.authorization ?? "", "Content-Type": "application/json",
          ...(typeof req.headers["x-workflow-actor"] === "string" ? { "X-Workflow-Actor": req.headers["x-workflow-actor"] } : {}) }, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
        const value = await response.text();
        if (req.method === "POST" && req.url === "/api/v2/work/submissions") {
          relayState.submissions++;
          if (relayState.dropSubmissionReply && response.ok) { relayState.dropSubmissionReply = false; req.socket.destroy(); return; }
        }
        if (req.method === "POST" && /^\/api\/v2\/work\/work_[a-f0-9]{32}\/stop$/.test(req.url ?? "")) {
          relayState.stopBodies.push(Buffer.concat(chunks).toString("utf8"));
          if (response.ok) relayState.stopReplies.push(JSON.parse(value));
          if (relayState.dropStopReply && response.ok) { relayState.dropStopReply = false; req.socket.destroy(); return; }
        }
        res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(value);
      } catch { res.writeHead(503, { "Content-Type": "application/json" }); res.end('{"error":"FixtureRelayUnavailable"}'); }
    });
    await new Promise<void>(done => relay!.listen(0, "127.0.0.1", done)); const relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
    writeFileSync(join(home, "app-support", "bag-resources.json"), JSON.stringify({ version: 2, generated: new Date().toISOString(), resources: {
      "actions.web": { bag: "actions", name: "web", kind: "service", url: webUrl }, "sessions.api": { bag: "sessions", name: "api", kind: "service", url: apiUrl }, "workflows.runtime": { bag: "workflows", name: "runtime", kind: "service", url: relayUrl },
    } }));
    let api: Child;
    const startApi = async () => { const child = options.managedEntry ? launch(entryArgs("sessions.api"), managedAmbient) : launch(["--import", "tsx", join(repo, "bags/sessions/api/src/index.ts")], { PORT: String(apiPort) });
      await serviceReady(child, "sessions.api", async () => { try { return (await fetch(apiUrl + "/health/live")).status === 200; } catch { return false; } }); return child; };
    api = await startApi();
    await storeSetup({ command: "seed-sessions" });
    const web = launch(entryArgs("actions.web"), managedAmbient);
    // Actions web has no signal handler; unlike Runtime and Sessions it exits via the delivered signal.
    web.termination = "SIGTERM";
    await serviceReady(web, "actions.web", async () => { try { return (await fetch(webUrl + "/health")).status === 200; } catch { return false; } });
    const request = (key: string = randomUUID(), mode: "finish" | "wait" = "finish") => ({ request_id: randomUUID(), idempotency_key: key, inputs: { mode } });
    const submit = (body: ReturnType<typeof request>) => fetch(apiUrl + "/api/v1/actions/fixtureinstalled%3Aprobe/work-start?session_id=owned", { method: "POST", headers, body: JSON.stringify(body) });
    const accept = async (body: ReturnType<typeof request>) => { const response = await submit(body); assert.equal(response.status, 201, await response.clone().text()); return acceptedSchema.parse(await response.json()); };
    const lookup = (key: string) => fetch(apiUrl + `/api/v1/actions/work-operations/${encodeURIComponent(key)}?session_id=owned`, { headers });
    const detail = (work: InstalledAcceptedWork) => fetch(apiUrl + `/api/v1/actions/runs/${work.run_id}?session_id=owned`, { headers: { ...headers, Accept: "application/json;profile=barry-action-work-v1" } });
    const workResult = async (work: InstalledAcceptedWork) => (await fetch(runtimeUrl + `/api/v2/work/${work.work_id}/result`, { headers })).json();
    const find = (name: string) => { const paths = readdirSync(home, { recursive: true }).map(String).filter(path => path.endsWith("/" + name)); if (paths.length !== 1) throw new Error(`Expected one ${name}, found ${paths.length}`); return join(home, paths[0]); };
    const read = <T>(path: string, operation: (db: Database.Database) => T): T => { const db = new Database(path, { readonly: true }); try { return operation(db); } finally { db.close(); } };
    const ownerRows = () => read(find("workflows.db"), db => db.prepare("SELECT record FROM workflow_work_admissions").all());
    const effects = (work: InstalledAcceptedWork) => { const path = join(action, `effects-${work.run_id}`); return existsSync(path) ? readFileSync(path, "utf8") : ""; };
    const childAlive = (work: InstalledAcceptedWork) => { const path = join(action, `ready-${work.run_id}`); if (!existsSync(path)) return false; const pid = Number(readFileSync(path, "utf8")); if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
    const execution = (work: InstalledAcceptedWork) => read(find("work-executor.db"), db => db.prepare("SELECT request,observation FROM executions WHERE json_extract(binding,'$.work_id')=?").get(work.work_id)) as { request: string; observation: string } | undefined;
    const reservation = (work: InstalledAcceptedWork) => { const row = execution(work); if (!row?.request) return null; const id = JSON.parse(row.request).resources.host_reservation;
      return read(find("work-resources.db"), db => db.prepare("SELECT state FROM resource_reservations WHERE reservation=?").get(id)) as { state: string } | undefined; };
    const receipt = (work: InstalledAcceptedWork) => read(find("work-executor.db"), db => { const row = db.prepare("SELECT receipt FROM execution_receipts WHERE json_extract(receipt,'$.work_id')=? ORDER BY revision DESC LIMIT 1").get(work.work_id) as { receipt: string } | undefined; return row ? JSON.parse(row.receipt) : null; });
    const leaseUntil = (work: InstalledAcceptedWork) => read(find("workflows.db"), db => Number((db.prepare("SELECT max(lease_until) value FROM workflow_commands WHERE run_id=?").get(work.workflow_id) as { value: number | null }).value ?? 0));
    const stopAudits = (work: InstalledAcceptedWork) => read(find("workflows.db"), db => db.prepare("SELECT details FROM workflow_events WHERE run_id=? AND type='WorkStopRequested'").all(work.workflow_id));
    const setBash = (allowed: boolean) => storeSetup({ command: "set-bash", allowed });
    const readOnlyBounds = () => storeSetup({ command: "read-only" });
    const endSession = () => storeSetup({ command: "end-session" });
    const sessionState = async () => JSON.parse(await storeSetup({ command: "session-state" })) as { state: string; ended_at: string | null };
    const rebindSession = () => storeSetup({ command: "rebind-session" });
    const restartApi = async () => { await stopChild(api); api = await startApi(); };
    const cliStop = async (work: InstalledAcceptedWork, revision: number, id = randomUUID()) => {
      const cli = launch([join(repo, "cli/bin/barry.js"), "--identity-binding", JSON.stringify({ id: 42, home }), "action", "stop", work.run_id,
        "--session", "owned", "--revision", String(revision), "--reason", "Stop installed identity script", "--request-id", id], { BARRY_SECRET: undefined }); await cli.closed; return { code: cli.process.exitCode, stdout: cli.stdout, stderr: cli.stderr, requestId: id };
    };
    const cli = async (args: string[]) => { const child = launch([join(repo, "cli/bin/barry.js"), "--identity-binding", JSON.stringify({ id: 42, home }), "action", ...args], { BARRY_SECRET: undefined }); await child.closed; return { code: child.process.exitCode, stdout: child.stdout, stderr: child.stderr }; };
    const stop = (work: InstalledAcceptedWork, revision: number) => fetch(apiUrl + `/api/v1/actions/runs/${work.run_id}/work-stop?session_id=owned`, { method: "POST", headers,
      body: JSON.stringify({ reason: "Closed session must not authorize Stop", request_id: randomUUID(), expected_revision: revision }) });
    const rejectManagedConfiguration = async (service: string, entries: unknown) => {
      if (!options.managedEntry) throw new Error("Managed-entry fixture required");
      const original = readFileSync(configPath, "utf8");
      try {
        writeFileSync(configPath, JSON.stringify({ ...configuration, services: { ...configuration.services, [service]: { env: entries } } }));
        const child = launch(entryArgs(service), managedAmbient); await child.closed;
        return { code: child.process.exitCode, stdout: child.stdout, stderr: child.stderr };
      } finally { writeFileSync(configPath, original); }
    };
    return { rebindSession, webUrl, apiUrl, secret, root, home, action, identity: initialized.identity, installation: initialized.installation, request, submit, accept, lookup, detail, workResult, ownerRows, effects, childAlive, execution, reservation, receipt,
      setBash, readOnlyBounds, endSession, sessionState, restartApi, cliStop, cli, stop, leaseUntil, stopAudits, writeIdentitySecret, relayState, close, expectedCredentialDigest: createHash("sha256").update(selectedSecret).digest("hex"), selectedSecret,
      rejectManagedConfiguration, effectFiles: () => readdirSync(action).filter(name => name.startsWith("effects-")),
      managedDefinitions: () => JSON.parse(readFileSync(join(home, "app-support", "service-definitions.json"), "utf8")),
      diagnostics: () => children.map(child => ({ pid: child.process.pid, done: child.done, code: child.process.exitCode, stdout: child.stdout, stderr: child.stderr })) };
  } catch (error) {
    const diagnostics = JSON.stringify(children.map(child => ({ pid: child.process.pid, done: child.done, stdout: child.stdout, stderr: child.stderr })));
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `Installed identity setup and cleanup failed: ${diagnostics}`); }
    throw new Error(`Installed identity setup failed: ${diagnostics}`, { cause: error });
  }
}
