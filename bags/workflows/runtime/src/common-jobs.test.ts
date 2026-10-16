import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sessionToken } from "@barry-rocks/sdk/auth";
import { SqliteDatabase } from "@barry-rocks/sdk/internal/stores";
import { WorkResourceBroker, inspectArtifact } from "@barry-rocks/sdk/internal/workflows";

it.each([false, true])("installed node jobs preserve local placement, canonical results and live named-bound revocation (external=%s)", async external => {
  const root = mkdtempSync(join(tmpdir(), "installed-node-jobs-")), home = join(root, "home"), bag = join(root, "fixturejobs"); mkdirSync(bag);
  const snapshot = join(root, "bags.json"), keys = join(root, "keys.json"), secret = "installed-node-job-fixture";
  const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
  const common = { version: 1, bounds: ["fixturejobs:local"], runs: { using: "node", main: "echo.mjs" }, input_schema: schema, output_schema: { type: "object" }, timeout: "15s" };
  writeFileSync(join(bag, "bag.yaml"), JSON.stringify({ name: "fixturejobs", description: "Disposable common node jobs", jobs: {
    echo: { ...common, description: "Return a bounded value" },
    loop: { ...common, description: "Wait for revocation", runs: { using: "node", main: "loop.mjs" } },
  } }));
  writeFileSync(join(bag, "echo.mjs"), 'process.stderr.write("installed host diagnostic");const input=JSON.parse(process.getBuiltinModule("node:fs").readFileSync(0,"utf8"));process.stdout.write(JSON.stringify({value:input.value,credential:process.env.BARRY_SECRET??null}));');
  writeFileSync(join(bag, "loop.mjs"), "while(true){}");
  writeFileSync(snapshot, JSON.stringify({ bags: { workflows: { type: "local", path: fileURLToPath(new URL("../../", import.meta.url)) }, fixturejobs: { type: "local", path: bag } } }));
  writeFileSync(keys, JSON.stringify({ "workflows.runtime.operator": [{ id: "operator", secret: "fixture-only-installed-node-job-issuer", not_before: Date.now() - 1000, not_after: Date.now() + 3600000 }] }), { mode: 0o600 });
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve)); const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const hostMap = join(root, "hosts.json"), credential = join(root, "host-credential");
  const url = `http://127.0.0.1:${port}`, env = { PATH: process.env.PATH, BARRY_HOME: home, BARRY_SECRET: secret, BARRY_BAGS_SNAPSHOT: snapshot, BARRY_WORKFLOW_DELEGATION_KEYS: keys, PORT: String(port), ...(external ? { BARRY_WORKFLOW_COMMON_HOSTS: hostMap } : {}) };
  const children: { child: ReturnType<typeof spawn>; closed: Promise<void> }[] = [];
  const launch = (args: string[], cwd?: string) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }); let out = "", error = "";
    child.stdout!.on("data", data => { out += String(data); }); child.stderr!.on("data", data => { error = (error + String(data)).slice(-12000); });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve())); children.push({ child, closed }); return { child, closed, output: () => out, error: () => error };
  };
  const setBound = async (restricted: boolean) => {
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "identity.yaml"), JSON.stringify({
      bounds: {
        "fixturejobs:local": {
          description: "Local placement",
          files: { allow: [] },
          nodes: { allow: ["local"] },
          ...(restricted ? { network: { deny: ["example.com"] } } : {}),
        },
      },
    }));
  };
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  const call = (path: string) => fetch(url + path, { headers });
  const start = (ref: string, key: string, inputs: unknown = { value: "installed-job-result" }) => fetch(url + "/api/v2/work/start", { method: "POST", headers: { Cookie: `barry_session=${sessionToken(secret)}`, Origin: url, "Content-Type": "application/json" }, body: JSON.stringify({ version: 2, request_id: randomUUID(), idempotency_key: key, definition: { kind: "job", reference: ref }, inputs }) });
  let broker: WorkResourceBroker | undefined;
  try {
    await setBound(false);
    let externalWorker: string | undefined;
    if (external) {
      const setup = launch(["--import", "tsx", "--input-type=module", "--eval", `import{installationRegistry}from'@barry-rocks/sdk/internal/nodes';import{writeFileSync}from'node:fs';const peers=installationRegistry();const invited=peers.inviteWorker('job-host',['fixturejobs:echo@1','fixturejobs:loop@1']);writeFileSync(${JSON.stringify(credential)},invited.credential,{mode:0o600,flag:'wx'});writeFileSync(${JSON.stringify(hostMap)},JSON.stringify({version:1,mode:'external',worker_ids:[invited.worker.id]}));process.stdout.write(JSON.stringify({worker:invited.worker.id}));peers.close();`], fileURLToPath(new URL("../", import.meta.url)));
      await setup.closed; expect(setup.child.exitCode, setup.error()).toBe(0); externalWorker = JSON.parse(setup.output()).worker;
    }
    const owner = launch(["--import", "tsx", fileURLToPath(new URL("./service.ts", import.meta.url))]);
    await expect.poll(() => owner.output() + owner.error(), { timeout: 15000 }).toContain("runtime ready");
    const metadata = await (await call("/api/metadata")).json();
    expect(metadata.work.definitions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "job", reference: "fixturejobs:echo@1", input_schema: schema })]));
    const paths = readdirSync(home, { recursive: true }).map(String), database = join(home, paths.find(path => path.endsWith("/workflows.db"))!);
    if (external) {
      const config = join(root, "host.json");
      writeFileSync(config, JSON.stringify({ version: 1, installation: metadata.installation, directory: join(root, "separate-host"), artifact_root: join(dirname(database), "work-artifacts"),
        owners: [{ id: metadata.installation, url, credential_file: credential }], activities: ["echo", "loop"].map(name => ({ type: `fixturejobs:${name}@1`, source: join(bag, `${name}.mjs`), digest: inspectArtifact(join(bag, `${name}.mjs`), `fixturejobs:${name}@1`, "1", false).digest })), capacity: 1 }));
      const host = launch([fileURLToPath(new URL("../../../../sdk/dist/workflows/work-process-host-cli.js", import.meta.url)), "--config", config]);
      await expect.poll(() => host.output() + host.error(), { timeout: 10000 }).toContain("process-work-host-ready");
    }
    const invalid = await start("fixturejobs:echo@1", "invalid", { value: 7 }); expect(invalid.status, await invalid.clone().text()).toBe(400);
    const response = await start("fixturejobs:echo@1", "installed-job"); expect(response.status, await response.clone().text() + owner.error()).toBe(201); const work = (await response.json()).work;
    await expect.poll(async () => (await (await call(`/api/v2/work/${work.work_id}`)).json()).state, { timeout: 15000 }).toBe("completed");
    const result = await (await call(`/api/v2/work/${work.work_id}/result`)).json();
    expect(result.outcome).toEqual({ ok: true, value: { value: "installed-job-result", credential: null } });
    expect(result.logs[0]).toMatchObject({ stage: "execution", value: { stderr: "installed host diagnostic", stderr_truncated: false } });
    const replay = await start("fixturejobs:echo@1", "installed-job"); expect(replay.status).toBe(200); expect((await replay.json()).work.work_id).toBe(work.work_id);
    const db = new SqliteDatabase(database);
    try {
      expect(db.prepare("SELECT a.worker FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=?").all(work.workflow_id)).toEqual([{ worker: externalWorker ?? `${metadata.installation}:common` }]);
      const admission = JSON.parse(String(db.prepare("SELECT record FROM workflow_work_admissions WHERE run_id=?").get(work.workflow_id)!.record));
      expect(admission.plan.node_job.scope.bound).toMatchObject({ files: { allow: [] }, nodes: { allow: ["local"] } });
    } finally { db.close(); }
    const looping = await start("fixturejobs:loop@1", "revoked-job"); expect(looping.status).toBe(201); const waiting = (await looping.json()).work;
    await expect.poll(async () => (await (await call(`/api/v2/work/${waiting.work_id}`)).json()).facts.physical, { timeout: 10000 }).toBe("running");
    const inspect = new SqliteDatabase(database); let reservationId: string;
    try { reservationId = JSON.parse(String(inspect.prepare("SELECT request FROM workflow_work_executions WHERE run_id=?").get(waiting.workflow_id)!.request)).resources.host_reservation; } finally { inspect.close(); }
    broker = new WorkResourceBroker({ path: join(dirname(database), "work-resources.db"), broker: metadata.installation, limits: { [metadata.installation]: { kind: "host" } } }); expect(broker.inspect(reservationId!)?.state).toBe("held");
    await setBound(true);
    await expect.poll(() => broker!.inspect(reservationId!)?.state, { timeout: 10000 }).toBe("released");
    const stopped = new SqliteDatabase(database);
    try {
      const receipt = JSON.parse(String(stopped.prepare("SELECT receipt FROM workflow_work_executions WHERE run_id=?").get(waiting.workflow_id)!.receipt));
      expect(receipt).toMatchObject({ physical_state: "ceased", effect_certainty: "uncertain", outcome: "uncertain" });
      expect(stopped.prepare("SELECT count(*) n FROM workflow_attempts a JOIN workflow_commands c ON c.id=a.command_id WHERE c.run_id=?").get(waiting.workflow_id)?.n).toBe(1);
    } finally { stopped.close(); }
    const denied = await start("fixturejobs:echo@1", "denied-after-bound-change"); expect(denied.status, await denied.clone().text()).toBe(409); expect(await denied.json()).toMatchObject({ code: "UnsupportedNodeJob" });
    owner.child.kill("SIGTERM"); await owner.closed; expect(owner.child.exitCode, owner.error()).toBe(0);
  } finally {
    for (const process of children.reverse()) { if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGTERM"); await process.closed; }
    broker?.close(); rmSync(root, { recursive: true, force: true });
  }
}, 60000);
