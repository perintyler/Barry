import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer as portServer } from "node:net";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { sessionToken } from "@barry-rocks/sdk/auth";
import {
  ExecutorJournal,
  WorkArtifactStore,
  WorkResourceBroker,
  inspectArtifact,
  processWorkHostConfigSchema,
} from "@barry-rocks/sdk/internal/workflows";
import { SqliteDatabase } from "@barry-rocks/sdk/internal/stores";
import { builtinArtifact } from "../../src/index.js";
import { readCommonHosts } from "./common-work.js";

it("installed external host uses registered scoped credentials, retains delivery over owner death and never claims legacy work", async () => {
  const root = mkdtempSync(join(tmpdir(), "installed-process-host-")), processes: { child: ReturnType<typeof spawn>; closed: Promise<void> }[] = [];
  const reservation = portServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`, secret = "installed-external-host-fixture", home = join(root, "home");
  const snapshot = join(root, "bags.json"), keys = join(root, "keys.json"), hostsFile = join(root, "common-hosts.json");
  writeFileSync(snapshot, JSON.stringify({ bags: { workflows: { type: "local", path: fileURLToPath(new URL("../../", import.meta.url)) } } }));
  writeFileSync(keys, JSON.stringify({ "workflows.runtime.operator": [{ id: "operator", secret: "fixture-only-installed-external-host-key", not_before: Date.now() - 1000, not_after: Date.now() + 3600000 }] }), { mode: 0o600 });
  const launch = (entry: string, args: string[], env = process.env, nodeArgs: string[] = []) => {
    const child = spawn(process.execPath, [...nodeArgs, entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = ""; child.stdout!.on("data", data => { output += String(data); }); child.stderr!.on("data", data => { errors = (errors + String(data)).slice(-8000); });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve())); processes.push({ child, closed });
    return { child, closed, output: () => output, errors: () => errors };
  };
  const startOwner = async (external: boolean, ready = true) => {
    const runtime = launch(fileURLToPath(new URL("./service.ts", import.meta.url)), [], {
      PATH: process.env.PATH, BARRY_HOME: home, BARRY_SECRET: secret, BARRY_BAGS_SNAPSHOT: snapshot, PORT: String(port), BARRY_WORKFLOW_DELEGATION_KEYS: keys,
      ...(external ? { BARRY_WORKFLOW_COMMON_HOSTS: hostsFile } : {}),
    }, ["--import", "tsx"]);
    if (ready) await expect.poll(() => runtime.output() + runtime.errors(), { timeout: 15000 }).toContain("runtime ready");
    else { await expect.poll(() => runtime.child.exitCode, { timeout: 10000 }).not.toBeNull(); await runtime.closed; }
    return runtime;
  };
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  const call = (path: string) => fetch(url + path, { headers });
  const startWork = async (key: string) => {
    const response = await fetch(url + "/api/v2/work/start", { method: "POST", headers: { Cookie: `barry_session=${sessionToken(secret)}`, Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 2, request_id: randomUUID(), idempotency_key: key, definition: { kind: "workflow", reference: "echo", version: "1" }, inputs: { message: key } }) });
    expect(response.status, await response.clone().text()).toBe(201); return (await response.json()).work;
  };
  let release!: () => void, waiting = 0, withhold = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const proxy = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks).toString();
      if (JSON.parse(body).request.operation === "complete" && withhold) { waiting++; await gate; response.writeHead(503).end(); return; }
      const upstream = await fetch(url + "/api/worker", { method: "POST", headers: { Authorization: request.headers.authorization ?? "", "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(5000) });
      response.writeHead(upstream.status, { "Content-Type": "application/json" }).end(await upstream.text());
    } catch { response.writeHead(503).end(); }
  });
  let registry: NodeRegistry | undefined, journal: ExecutorJournal | undefined, secondJournal: ExecutorJournal | undefined, artifacts: WorkArtifactStore | undefined, broker: WorkResourceBroker | undefined;
  try {
    const bootstrap = await startOwner(false), installation = (await (await call("/api/metadata")).json()).installation;
    const paths = readdirSync(home, { recursive: true }).map(String), database = join(home, paths.find(path => path.endsWith("/workflows.db"))!), data = dirname(database);
    const fault = new SqliteDatabase(database);
    try { fault.exec("CREATE TRIGGER hold_embedded_receipt BEFORE UPDATE OF receipt ON workflow_work_executions WHEN NEW.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture holds embedded receipt'); END"); }
    finally { fault.close(); }
    artifacts = new WorkArtifactStore(join(data, "work-artifacts"));
    const retainedWork = await startWork("retained-embedded-result"), embeddedJournal = new ExecutorJournal({ path: join(data, "work-executor.db"), installation, artifacts });
    let retained: NonNullable<ReturnType<ExecutorJournal["nextDelivery"]>>;
    try {
      await expect.poll(() => embeddedJournal.pendingDeliveryCount(), { timeout: 10000 }).toBe(1);
      retained = embeddedJournal.nextDelivery(installation)!; expect(retained.receipt.outcome).toBe("complete");
    } finally { embeddedJournal.close(); }
    bootstrap.child.kill("SIGTERM"); await bootstrap.closed; expect(bootstrap.child.exitCode, bootstrap.errors()).toBe(0);
    const repaired = new SqliteDatabase(database); try { repaired.exec("DROP TRIGGER hold_embedded_receipt"); } finally { repaired.close(); }
    registry = new NodeRegistry(dirname(join(home, paths.find(path => path.endsWith("/peers.db"))!)));
    const invited = registry.inviteWorker("independent-common-host", ["workflows:echo@1"]), second = registry.inviteWorker("second-common-host", ["workflows:echo@1"]), unrelated = registry.inviteWorker("unmapped-common-host");
    const denied = registry.inviteWorker("wrong-scope-host", ["other:job@1"]);
    for (const worker of [denied.worker.id, randomUUID()]) {
      writeFileSync(hostsFile, JSON.stringify({ version: 1, mode: "external", worker_ids: [worker] }));
      const rejected = await startOwner(true, false); expect(rejected.child.exitCode).toBe(1); expect(rejected.output()).not.toContain("runtime ready");
    }
    writeFileSync(hostsFile, JSON.stringify({ version: 1, mode: "external", worker_ids: [invited.worker.id, second.worker.id] }));
    const credential = join(root, "worker-credential"); writeFileSync(credential, invited.credential, { mode: 0o600 });
    const owner = await startOwner(true);
    await expect.poll(async () => (await (await call(`/api/v2/work/${retainedWork.work_id}`)).json()).state, { timeout: 10000 }).toBe("needs-attention");
    const reviewPath = `/api/v2/work/${retainedWork.work_id}/reconciliation`;
    await expect.poll(async () => (await (await call(reviewPath)).json()).receipts.length, { timeout: 10000 }).toBe(1);
    const evidence = await (await call(reviewPath)).json();
    expect(evidence.receipts).toEqual([expect.objectContaining({ attempt_id: retained.binding.attempt_id, receipt_digest: retained.receipt.receipt_digest })]);
    const decision = { request_id: randomUUID(), expected_revision: evidence.revision, attempt_id: retained.binding.attempt_id, receipt_digest: retained.receipt.receipt_digest,
      reason: "Reviewed the original embedded worker result after its journal resumed delivery in external mode.", residual_risk: "Pure result retained before restart; no application relaunch." };
    const reconcile = () => fetch(url + reviewPath, { method: "POST", headers: { Cookie: `barry_session=${sessionToken(secret)}`, Origin: url, "Content-Type": "application/json" }, body: JSON.stringify(decision) });
    const applied = await reconcile(); expect(applied.status, await applied.clone().text()).toBe(200);
    expect(await (await reconcile()).json()).toEqual(await applied.json());
    await expect.poll(async () => (await (await call(`/api/v2/work/${retainedWork.work_id}`)).json()).state, { timeout: 10000 }).toBe("completed");
    expect((await fetch(url + "/api/metadata", { headers: { Authorization: `Bearer ${invited.credential}` } })).status).toBe(401);
    const v2 = await fetch(url + "/api/worker", { method: "POST", headers: { ...headers, Authorization: `Bearer ${invited.credential}` }, body: JSON.stringify({ request: { version: 2, operation: "hello", session: randomUUID() } }) });
    expect(v2.status).toBe(409); expect(await v2.json()).toMatchObject({ code: "WorkExecutorUnsupported" });
    const work = await startWork("external-only");
    const legacy = await fetch(url + "/api/runs", { method: "POST", headers, body: JSON.stringify({ id: "legacy-stays-local", type: "echo", version: "1", input: { message: "legacy" } }) }); expect(legacy.status).toBe(202);
    await expect.poll(async () => (await (await call("/api/runs/legacy-stays-local")).json()).run.status, { timeout: 10000 }).toBe("completed");
    await delay(500);
    const readDb = new SqliteDatabase(database);
    try { expect(readDb.prepare("SELECT count(*) n FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=?").get(work.workflow_id)?.n).toBe(0); }
    finally { readDb.close(); }
    // Even a broad legacy invitation cannot claim common work without a host mapping.
    const { connectWorkOwnerV3, ownerCall } = await import("@barry-rocks/sdk/internal/workflows");
    const outsider = connectWorkOwnerV3(installation, ownerCall(url, unrelated.credential));
    await outsider.advertise({ types: ["echo@1"], artifacts: { "echo@1": inspectArtifact(builtinArtifact, "echo", "1").digest }, capacity: 1 }, {
      version: 2, installation, boot_identity: "fixture-unmapped", observed_at: Date.now(), expires_at: Date.now() + 15000, executors: ["process"],
      features: ["journal-inspect", "cancel-tombstone", "stop-ack", "immutable-source", "scoped-effects", "declared-validation", "bounded-retries"], runtimes: {}, workspaces: [], containment: "portable", requires_validation_declaration: true,
    });
    await delay(2100); // Exhaust owner placement preference before testing host eligibility.
    expect(await outsider.claim(randomUUID())).toBeNull();
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const hostConfig = join(root, "host.json"), hostDirectory = join(root, "separate-host");
    writeFileSync(hostConfig, JSON.stringify({ version: 1, installation, directory: hostDirectory, artifact_root: join(data, "work-artifacts"),
      owners: [{ id: installation, url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, credential_file: credential }],
      activities: [{ type: "echo@1", source: builtinArtifact, digest: inspectArtifact(builtinArtifact, "echo", "1").digest }], capacity: 1 }));
    const host = launch(fileURLToPath(new URL("../../../../sdk/dist/workflows/work-process-host-cli.js", import.meta.url)), ["--config", hostConfig]);
    await expect.poll(host.output, { timeout: 10000 }).toContain("process-work-host-ready");
    await expect.poll(() => waiting, { timeout: 15000 }).toBeGreaterThan(0);
    journal = new ExecutorJournal({ path: join(hostDirectory, "work-executor.db"), installation, artifacts });
    const delivery = journal.nextDelivery(installation)!; expect(delivery.receipt.outcome).toBe("complete");
    const held = journal.retainedStart(delivery.binding)!.resources.host_reservation!;
    broker = new WorkResourceBroker({ path: join(data, "work-resources.db"), broker: installation, limits: { [installation]: { kind: "host" } } });
    expect(broker.inspect(held)?.state).toBe("held");
    const secondWork = await startWork("second-host"), secondCredential = join(root, "second-credential"), secondConfig = join(root, "second-host.json"), secondDirectory = join(root, "second-host");
    writeFileSync(secondCredential, second.credential, { mode: 0o600 });
    writeFileSync(secondConfig, JSON.stringify({ version: 1, installation, directory: secondDirectory, artifact_root: artifacts.root,
      owners: [{ id: installation, url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, credential_file: secondCredential }],
      activities: [{ type: "echo@1", source: builtinArtifact, digest: inspectArtifact(builtinArtifact, "echo", "1").digest }], capacity: 1 }));
    const secondHost = launch(fileURLToPath(new URL("../../../../sdk/dist/workflows/work-process-host-cli.js", import.meta.url)), ["--config", secondConfig]);
    await expect.poll(secondHost.output, { timeout: 10000 }).toContain("process-work-host-ready");
    await expect.poll(() => waiting, { timeout: 10000 }).toBeGreaterThan(1);
    secondJournal = new ExecutorJournal({ path: join(secondDirectory, "work-executor.db"), installation, artifacts });
    const secondDelivery = secondJournal.nextDelivery(installation)!, secondHeld = secondJournal.retainedStart(secondDelivery.binding)!.resources.host_reservation!;
    expect(secondDelivery.receipt.workflow_id).toBe(secondWork.workflow_id); expect(secondHeld).not.toBe(held);
    expect(broker.inspect(secondHeld)).toMatchObject({ state: "held", resource: installation });
    expect(broker.inspect(held)).toMatchObject({ state: "held", resource: installation });
    owner.child.kill("SIGKILL"); await owner.closed;
    for (const process of [host, secondHost]) expect(process.child.exitCode, process.errors()).toBeNull();
    expect(journal.pendingDeliveryCount()).toBe(1); expect(secondJournal.pendingDeliveryCount()).toBe(1);
    expect(artifacts.verify(delivery.receipt.output!).toString()).toBe('"external-only"');
    withhold = false; release();
    const replacement = await startOwner(true);
    await expect.poll(async () => (await (await call(`/api/v2/work/${work.work_id}`)).json()).state, { timeout: 15000 }).toBe("completed");
    await expect.poll(() => journal!.pendingDeliveryCount()).toBe(0); expect(broker.inspect(held)?.state).toBe("released");
    await expect.poll(async () => (await (await call(`/api/v2/work/${secondWork.work_id}`)).json()).state, { timeout: 15000 }).toBe("completed");
    await expect.poll(() => secondJournal!.pendingDeliveryCount()).toBe(0); expect(broker.inspect(secondHeld)?.state).toBe("released");
    expect((await (await call(`/api/v2/work/${work.work_id}/result`)).json()).outcome).toEqual({ ok: true, value: "external-only" });
    const verified = new SqliteDatabase(database);
    try {
      const attempts = verified.prepare("SELECT a.worker FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=?").all(work.workflow_id);
      expect(attempts).toEqual([{ worker: invited.worker.id }]);
      expect(verified.prepare("SELECT a.worker FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=?").all(secondWork.workflow_id)).toEqual([{ worker: second.worker.id }]);
      expect(verified.prepare("SELECT a.worker FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=?").all(retainedWork.workflow_id)).toEqual([{ worker: `${installation}:common` }]);
      expect(verified.prepare("SELECT a.worker FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id='legacy-stays-local'").get()?.worker).toBe(installation);
    } finally { verified.close(); }
    expect(registry.worker(invited.worker.id).joinedAt).not.toBeNull();
    host.child.kill("SIGTERM"); await host.closed; expect(host.child.exitCode, host.errors()).toBe(0);
    secondHost.child.kill("SIGTERM"); await secondHost.closed; expect(secondHost.child.exitCode, secondHost.errors()).toBe(0);
    replacement.child.kill("SIGTERM"); await replacement.closed; expect(replacement.child.exitCode, replacement.errors()).toBe(0);
  } finally {
    release?.(); for (const process of processes.reverse()) { if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGTERM"); await process.closed; }
    proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    journal?.close(); secondJournal?.close(); artifacts?.close(); broker?.close(); registry?.close(); rmSync(root, { recursive: true, force: true });
  }
}, 60000);

it("external host configuration refuses missing hosts, duplicate identities and unknown fields", () => {
  const root = mkdtempSync(join(tmpdir(), "common-host-configuration-")), file = join(root, "hosts.json");
  try {
    const duplicate = randomUUID();
    for (const input of [{ version: 1, mode: "external", worker_ids: [] }, { version: 1, mode: "embedded", worker_ids: ["not-an-id"] }, { version: 1, mode: "embedded", worker_ids: [duplicate, duplicate] }, { version: 1, mode: "embedded", worker_ids: [], credential: "must-not-echo" }]) {
      writeFileSync(file, JSON.stringify(input)); expect(() => readCommonHosts(file)).toThrow("configuration is unreadable or invalid");
    }
    expect(readCommonHosts()).toEqual({ version: 1, mode: "embedded", worker_ids: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("work-process-host-cli --verify-config validates remote workspace configuration and initializes durable lock store", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "process-host-remote-cli-")));
  try {
    const wsDir = join(root, "workspace-checkout");
    mkdirSync(wsDir, { mode: 0o700 });
    writeFileSync(join(wsDir, "README.md"), "# Verified Checkout\n", { mode: 0o600 });
    const wsStat = statSync(wsDir);
    const credFile = join(root, "worker.cred");
    writeFileSync(credFile, "barry_wk_remote_verify_token", { mode: 0o600 });
    const hostConfigPath = join(root, "remote-host.json");
    const config = processWorkHostConfigSchema.parse({
      version: 1,
      installation: "remote-worker-1",
      directory: join(root, "host-dir"),
      artifact_root: join(root, "artifacts"),
      owners: [{ id: "owner-1", url: "http://127.0.0.1:4100/", credential_file: credFile }],
      activities: [
        {
          type: "echo@1",
          source: builtinArtifact,
          digest: inspectArtifact(builtinArtifact, "echo", "1").digest,
        },
      ],
      capacity: 1,
      remote: {
        enabled: true,
        staging_root: join(root, "staging"),
        isolated_workspace_root: join(root, "isolated"),
        containment_posture: "portable-pgid",
        workspaces: [
          {
            version: 1,
            resource_ref: "repo:barry",
            mapping_version: 1,
            worker_installation: "remote-worker-1",
            canonical_root: wsDir,
            dev: wsStat.dev,
            ino: wsStat.ino,
            writable_allowed: true,
          },
        ],
      },
    });
    writeFileSync(hostConfigPath, JSON.stringify(config), { mode: 0o600 });

    const cliEntry = fileURLToPath(
      new URL("../../../../sdk/src/workflows/work-process-host-cli.ts", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliEntry, "--verify-config", hostConfigPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => {
      stdout += String(d);
    });
    child.stderr.on("data", d => {
      stderr += String(d);
    });
    const code = await new Promise<number | null>(resolve =>
      child.once("close", exitCode => resolve(exitCode)),
    );
    expect(code, stderr).toBe(0);
    expect(stdout).toContain("process-work-host-config-verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
