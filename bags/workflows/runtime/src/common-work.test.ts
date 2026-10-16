import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, copyFileSync, cpSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { builtinArtifact, jobArtifact, processArtifact, agentArtifact } from "../../src/index.js";
import { sessionToken } from "@barry-rocks/sdk/auth";
import { approveWorkflowBounds } from "@barry-rocks/sdk/bounds";
import { WorkDelegationIssuer, snapshotWorkflows, restoreWorkflows, inspectArtifact, type WorkAuthority, type WorkSubmission } from "@barry-rocks/sdk/internal/workflows";

it("runs delegated common work in the installed service alongside legacy work and recovers after disabling admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "installed-common-work-"));
  const portReservation = createServer();
  await new Promise<void>(resolve => portReservation.listen(0, "127.0.0.1", resolve));
  const port = (portReservation.address() as { port: number }).port;
  await new Promise<void>(resolve => portReservation.close(() => resolve()));
  const key = { id: "first", secret: "fixture-only-installed-work-delegation-key", not_before: Date.now() - 1000, not_after: Date.now() + 3600000 };
  const snapshot = join(root, "bags.snapshot.json");
  writeFileSync(snapshot, JSON.stringify({ bags: { workflows: { type: "local", path: fileURLToPath(new URL("../../", import.meta.url)) } } }));
  const keys = join(root, "keys.json");
  writeFileSync(keys, JSON.stringify({ "workflows.cli.operator": [key], "workflows.runtime.operator": [{ ...key, id: "operator", secret: "fixture-only-dedicated-local-operator-key" }] }), { mode: 0o600 });
  let issuer = new WorkDelegationIssuer({ path: join(root, "issuer.db"), issuer: "workflows.cli.operator", signingKey: () => key });
  const url = `http://127.0.0.1:${port}`;
  const headers = { Authorization: "Bearer test-common-work", "Content-Type": "application/json" };
  const call = (path: string, body?: unknown) => fetch(url + path, { headers, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const operatorCall = (body: unknown, origin = url) => fetch(url + "/api/v2/work/start", { method: "POST", headers: { Cookie: `barry_session=${sessionToken("test-common-work")}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<{ code: number | null; signal: string | null }>;
  let errors = "", succeeded = false;
  const start = async (admission: boolean) => {
    let output = ""; errors = "";
    child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./service.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, BARRY_HOME: join(root, "home"), BARRY_SECRET: "test-common-work", BARRY_BAGS_SNAPSHOT: snapshot, PORT: String(port), ...(admission ? { BARRY_WORKFLOW_DELEGATION_KEYS: keys } : {}) }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", data => { output += String(data); });
    child.stderr!.on("data", data => { errors += String(data); });
    exited = new Promise(resolve => child!.once("exit", (code, signal) => resolve({ code, signal })));
    await expect.poll(() => output + errors, { timeout: 15000 }).toContain("runtime ready");
  };
  const stop = async () => { child!.kill("SIGTERM"); expect(await exited).toEqual({ code: 0, signal: null }); child = undefined; };
  try {
    await start(true);
    const installation = (await (await call("/api/metadata")).json()).installation;
    expect(typeof installation).toBe("string");
    const scope = await approveWorkflowBounds({ bags: [], tools: [], bounds: [], boundByName: async () => undefined });
    const request: WorkSubmission = { version: 2, request_id: randomUUID(), idempotency_key: "installed-echo", authority_ref: "installed-operator-grant",
      definition: { kind: "workflow", reference: "echo", version: "1" }, inputs: { message: { from: "installed common worker" } }, origin: { entry_point: "work-cli", trigger: "manual" } };
    const authority: WorkAuthority = { namespace: { installation, principal_kind: "operator", principal_id: "local-operator", identity_id: null, caller_session_id: null }, caller_ceiling: scope, origin: request.origin, run_identity: null };
    issuer.register(request, authority, { kind: "operator", definition_owner_session: null, background_parent: false });
    const submission = { request, delegation: issuer.issue(request, authority) };
    const acceptedResponse = await call("/api/v2/work/submissions", submission);
    expect(acceptedResponse.status, (await acceptedResponse.clone().text()) + errors).toBe(201);
    const work = (await acceptedResponse.json()).work;
    expect((await call("/api/runs", { id: "legacy-beside-common", type: "echo", version: "1", input: { message: "legacy retained" } })).status).toBe(202);
    await expect.poll(async () => (await (await call(`/api/v2/work/${work.work_id}`)).json()).state, { timeout: 15000 }).toBe("completed");
    await expect.poll(async () => (await (await call("/api/runs/legacy-beside-common")).json()).run.status, { timeout: 5000 }).toBe("completed");
    expect((await (await call(`/api/v2/work/${work.work_id}/result`)).json()).outcome).toEqual({ ok: true, value: { from: "installed common worker" } });
    const duplicate = await call("/api/v2/work/submissions", submission);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).work.work_id).toBe(work.work_id);
    const details = await (await call(`/api/runs/${work.workflow_id}`)).json();
    const command = await (await call(`/api/runs/${work.workflow_id}/command?id=${encodeURIComponent(details.commands[0].id)}`)).json();
    expect(command.attempts).toHaveLength(1);
    const operatorRequest = { version: 2, request_id: randomUUID(), idempotency_key: "operator-echo", definition: { kind: "workflow", reference: "echo", version: "1" }, inputs: { message: "stopped before work", delayMs: 60000 } };
    expect((await (await call("/api/metadata")).json()).work.enabled).toBe(true);
    expect((await call("/api/v2/work/start", operatorRequest)).status).toBe(403);
    expect((await operatorCall(operatorRequest, "https://untrusted.example")).status).toBe(403);
    expect((await operatorCall({ ...operatorRequest, origin: { trigger: "schedule" } })).status).toBe(400);
    const operatorResponse = await operatorCall(operatorRequest);
    expect(operatorResponse.status, await operatorResponse.clone().text()).toBe(201);
    const operatorWork = (await operatorResponse.json()).work;
    expect(operatorWork.namespace.principal_id).toBe("local-operator");
    const operatorDuplicate = await operatorCall({ ...operatorRequest, request_id: randomUUID() });
    expect(operatorDuplicate.status).toBe(200); expect((await operatorDuplicate.json()).work.work_id).toBe(operatorWork.work_id);
    await expect.poll(async () => (await (await call(`/api/v2/work/${operatorWork.work_id}`)).json()).state).toBe("waiting");
    const current = await (await call(`/api/v2/work/${operatorWork.work_id}`)).json();
    const stopRequest = { request_id: randomUUID(), expected_revision: current.revision };
    const stopped = await call(`/api/v2/work/${operatorWork.work_id}/stop`, stopRequest);
    expect(stopped.status).toBe(200); const stopAck = await stopped.json();
    expect(stopAck.stop_requested).toBe(true);
    expect(await (await call(`/api/v2/work/${operatorWork.work_id}/stop`, stopRequest)).json()).toEqual(stopAck);
    await stop(); await start(true);
    const afterRestart = await operatorCall({ ...operatorRequest, request_id: randomUUID() });
    expect(afterRestart.status).toBe(200); expect((await afterRestart.json()).work.work_id).toBe(operatorWork.work_id);
    expect((await (await call(`/api/v2/work/${operatorWork.work_id}/result`)).json()).outcome).toMatchObject({ ok: false, error: { code: "Cancelled" } });
    await stop();
    const databases = readdirSync(join(root, "home"), { recursive: true }).map(String).filter(path => path.endsWith("/workflows.db")); expect(databases).toHaveLength(1);
    const database = join(root, "home", databases[0]), data = dirname(database), backup = join(root, "activation-backup"), restored = join(root, "activation-restore");
    const legacySnapshotArtifacts = [inspectArtifact(builtinArtifact, "echo", "1"), inspectArtifact(builtinArtifact, "echo@1", "1", false), inspectArtifact(jobArtifact, "job", "1"), inspectArtifact(processArtifact, "action-script", "2")];
    const captureSnapshot = (destination: string, artifacts: typeof legacySnapshotArtifacts) => snapshotWorkflows(database, destination, installation, artifacts, join(data, "work-artifacts"), { version: 1, components: [
      { id: "executor", role: "executor", identity: installation, path: join(data, "work-executor.db"), artifact_root: join(data, "work-artifacts"), workers: [`${installation}:common`] },
      { id: "broker", role: "broker", identity: installation, path: join(data, "work-resources.db") },
      { id: "operator", role: "issuer", identity: "workflows.runtime.operator", path: join(data, "work-operator-issuer.db") },
      { id: "fixture", role: "issuer", identity: "workflows.cli.operator", path: join(root, "issuer.db") },
    ] });
    const incomplete = join(root, "activation-backup-missing-agent");
    await expect(captureSnapshot(incomplete, legacySnapshotArtifacts)).rejects.toThrow("snapshot is missing a pinned artifact");
    expect(existsSync(incomplete)).toBe(false);
    const agent = inspectArtifact(agentArtifact, "action-agent", "1");
    await captureSnapshot(backup, [...legacySnapshotArtifacts, agent]);
    expect(JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")).artifacts).toContainEqual(expect.objectContaining({ type: agent.type, version: agent.version, digest: agent.digest }));
    await start(true);
    const missingRequest = { ...operatorRequest, idempotency_key: "after-backup-lost-key", inputs: { message: "actual post-snapshot result" } };
    const missingResponse = await operatorCall(missingRequest); expect(missingResponse.status).toBe(201); const missing = (await missingResponse.json()).work;
    await expect.poll(async () => (await (await call(`/api/v2/work/${missing.work_id}`)).json()).state, { timeout: 15000 }).toBe("completed");
    await stop(); issuer.close();
    await restoreWorkflows(backup, restored, installation, true, true);
    const install = (source: string, target: string) => { for (const suffix of ["", "-wal", "-shm"]) rmSync(target + suffix, { force: true }); copyFileSync(source, target); };
    install(join(restored, "workflows.db"), database);
    install(join(restored, "work-recovery", "executor.db"), join(data, "work-executor.db"));
    install(join(restored, "work-recovery", "broker.db"), join(data, "work-resources.db"));
    install(join(restored, "work-recovery", "operator.db"), join(data, "work-operator-issuer.db"));
    install(join(restored, "work-recovery", "fixture.db"), join(root, "issuer.db"));
    rmSync(join(data, "work-artifacts"), { recursive: true, force: true }); cpSync(join(restored, "work-artifacts"), join(data, "work-artifacts"), { recursive: true });
    issuer = new WorkDelegationIssuer({ path: join(root, "issuer.db"), issuer: "workflows.cli.operator", signingKey: () => key });
    await start(true);
    const recovery = (await (await call("/api/v2/recovery")).json()).recovery, epoch = recovery.epoch;
    expect(recovery.active).toBe(false); expect((await call("/ready")).status).toBe(503);
    expect((await (await call("/api/metadata")).json()).work.enabled).toBe(false);
    expect((await call(`/api/v2/work/operations?key=${missingRequest.idempotency_key}`)).status).toBe(404);
    expect((await (await operatorCall(missingRequest)).json()).code).toBe("RecoveryAdmissionPaused");
    expect((await (await call("/api/v2/work/submissions", submission)).json()).work.work_id).toBe(work.work_id);
    const activation = { request_id: randomUUID(), expected_epoch: epoch, reason: "Reviewed the surviving post-snapshot receipt before activating this isolated fixture.", residual_risk: "The lost invocation stays unresolved; enable separate new invocations only.", effect_paths_fenced: true, post_snapshot_work_reviewed: true };
    const activated = await call("/api/v2/recovery/activate", activation); expect(activated.status).toBe(200); const activationAck = await activated.json();
    await stop(); await start(true);
    expect(await (await call("/api/v2/recovery/activate", activation)).json()).toEqual(activationAck);
    expect((await (await operatorCall(missingRequest)).json()).code).toBe("RecoveryEpochRequired");
    const newRequest = { ...operatorRequest, idempotency_key: `${epoch}:separate-new-invocation`, recovery_epoch: epoch, inputs: { message: "new generation result" } };
    const freshResponse = await operatorCall(newRequest); expect(freshResponse.status, await freshResponse.clone().text()).toBe(201); const fresh = (await freshResponse.json()).work;
    await expect.poll(async () => (await (await call(`/api/v2/work/${fresh.work_id}`)).json()).state, { timeout: 15000 }).toBe("completed");
    expect((await (await call(`/api/v2/work/${fresh.work_id}/result`)).json()).outcome).toEqual({ ok: true, value: "new generation result" });
    const unsupported: WorkSubmission = { ...request, recovery_epoch: epoch, request_id: randomUUID(), idempotency_key: `${epoch}:unsupported`, authority_ref: "unsupported-grant", definition: { kind: "workflow", reference: "unregistered", version: "1" } };
    issuer.register(unsupported, authority, { kind: "operator", definition_owner_session: null, background_parent: false });
    expect((await call("/api/v2/work/submissions", { request: unsupported, delegation: issuer.issue(unsupported, authority) })).status).toBe(422);
    writeFileSync(keys, "{}");
    expect((await call("/api/v2/work/submissions", submission)).status).toBe(403);
    expect((await (await call(`/api/v2/work/${work.work_id}`)).json()).state).toBe("completed");
    const list = await (await call("/api/v2/work")).json();
    expect(list.total).toBe(3);
    expect(errors).not.toContain("common_worker_failed");
    await stop();
    await start(false);
    expect((await (await call(`/api/v2/work/operations?key=${request.idempotency_key}`)).json()).work_id).toBe(work.work_id);
    expect((await (await call(`/api/v2/work/${work.work_id}/result`)).json()).outcome).toEqual({ ok: true, value: { from: "installed common worker" } });
    expect((await call("/api/v2/work/submissions", submission)).status).toBe(404);
    expect(errors).not.toMatch(/closed database|not open|common_worker_failed/);
    await stop();
    succeeded = true;
  } catch (error) {
    try { writeFileSync(join(root, "failure-before-cleanup.json"), JSON.stringify({ pid: child?.pid, exitCode: child?.exitCode, signalCode: child?.signalCode, errors }), { mode: 0o600 }); }
    catch (preservation) { throw new AggregateError([error, preservation], "Common Work failure evidence incomplete; retained " + root); }
    throw new Error("Common Work integration failed; retained " + root, { cause: error });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited!; }
    issuer.close(); if (succeeded) rmSync(root, { recursive: true, force: true });
  }
}, 45000);
