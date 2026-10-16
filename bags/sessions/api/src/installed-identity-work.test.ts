import { expect, it } from "vitest";
import { z } from "zod";
import { installedIdentityWork, type InstalledAcceptedWork } from "./testing/installed-identity-work.js";

const cliAdmission = z.object({ runId: z.string(), workId: z.string(), workflowId: z.string(), idempotencyKey: z.string(), created: z.boolean() });
const fromCli = (value: unknown): InstalledAcceptedWork => { const work = cliAdmission.parse(value); return { run_id: work.runId, work_id: work.workId, workflow_id: work.workflowId, idempotency_key: work.idempotencyKey, created: work.created }; };
async function scenario(run: (fixture: Awaited<ReturnType<typeof installedIdentityWork>>) => Promise<void>, options: Parameters<typeof installedIdentityWork>[0] = {}) {
  const fixture = await installedIdentityWork(options);
  try { await run(fixture); }
  catch (error) { console.error("installed identity process diagnostics", JSON.stringify(fixture.diagnostics())); throw error; }
  finally { await fixture.close(); }
}

it("admits an installed script from the identity executable with real current policy and only its declared identity credential", async () => scenario(async f => {
  const request = f.request("identity-cli-finish");
  const cli = await f.cli(["work-start", "fixtureinstalled:probe", "--session", "owned", "--key", request.idempotency_key, "--request-id", request.request_id, "--input-json", JSON.stringify(request.inputs)]);
  expect(cli.code, cli.stderr).toBe(0); expect(cli.stderr).toContain(request.idempotency_key);
  const work = fromCli(JSON.parse(cli.stdout)); expect(work.created).toBe(true);
  await expect.poll(async () => (await f.workResult(work)).outcome?.ok, { timeout: 20000 }).toBe(true);
  expect((await f.workResult(work)).outcome).toEqual({ ok: true, value: { credential_digest: f.expectedCredentialDigest, id: work.run_id } });
  const duplicate = await f.submit(request); expect(duplicate.status, await duplicate.clone().text()).toBe(200);
  expect(await duplicate.json()).toMatchObject({ run_id: work.run_id, work_id: work.work_id, created: false });
  expect(f.effects(work)).toBe("once"); expect(f.ownerRows()).toHaveLength(1);
  const admission = JSON.parse(String((f.ownerRows()[0] as { record: string }).record));
  expect(admission).toMatchObject({ namespace: { principal_kind: "identity", principal_id: f.identity, identity_id: f.identity, caller_session_id: "owned" },
    plan: { process_program: { credential_owner: { kind: "identity", identity: f.identity }, secret_names: ["SCRIPT_KEY"] } } });
  expect(JSON.stringify(f.ownerRows())).not.toContain(f.selectedSecret); expect(JSON.stringify(f.execution(work))).not.toContain(f.selectedSecret);
  f.writeIdentitySecret(false);
  const unavailable = await f.submit(f.request("missing-selected-secret")); expect(unavailable.status).toBe(409);
  const refusal = await unavailable.json(); expect(refusal.code ?? refusal.error).toBe("WorkCredentialsUnavailable"); expect(f.ownerRows()).toHaveLength(1);
  f.writeIdentitySecret(true); await f.setBash(false);
  const revoked = await f.submit(f.request("revoked-selected-bash")); expect(revoked.status).toBe(403);
  expect(f.ownerRows()).toHaveLength(1); expect(f.effects(work)).toBe("once");
}), 90_000);

it("recovers accepted reply loss after API restart using read-only policy and the original ended session", async () => scenario(async f => {
  const request = f.request("lost-installed-admission"); f.relayState.dropSubmissionReply = true;
  const lost = await f.submit(request); expect(lost.status).toBe(503);
  expect(f.ownerRows()).toHaveLength(1);
  const persisted = JSON.parse(String((f.ownerRows()[0] as { record: string }).record));
  const work: InstalledAcceptedWork = { run_id: persisted.action_id, work_id: persisted.work_id, workflow_id: persisted.workflow_id, idempotency_key: request.idempotency_key, created: true };
  await expect.poll(async () => (await f.workResult(work)).outcome?.ok, { timeout: 20000 }).toBe(true);
  await f.readOnlyPolicy(); await f.endSession(); await f.restartApi();
  // The caller was explicitly ended in its real store before API restart.
  // Recovery must preserve that closure and must not renew admission.
  await expect.poll(async () => (await f.sessionState()).state, { timeout: 15000 }).toBe("closed");
  const recovered = await f.cli(["work-lookup", request.idempotency_key, "--session", "owned"]);
  expect(recovered.code, recovered.stderr).toBe(0); expect(fromCli(JSON.parse(recovered.stdout))).toEqual({ ...work, created: false });
  const lookup = await f.lookup(request.idempotency_key); expect(lookup.status, await lookup.clone().text()).toBe(200);
  expect(await lookup.json()).toMatchObject({ run_id: work.run_id, work_id: work.work_id, workflow_id: work.workflow_id, idempotency_key: request.idempotency_key, created: false });
  expect((await f.submit(request)).status).toBe(403);
  expect(f.relayState.submissions).toBe(1); expect(f.ownerRows()).toHaveLength(1); expect(f.effects(work)).toBe("once");
}), 90_000);

it("uses the installed identity executable to Stop a real admitted native activity while capacity remains held until physical cessation", async () => scenario(async f => {
  const work = await f.accept(f.request("native-identity-stop", "wait"));
  await expect.poll(() => f.childAlive(work), { timeout: 20000 }).toBe(true);
  expect(f.reservation(work)).toMatchObject({ state: "held" }); expect(f.receipt(work)).toBeNull(); expect(f.effects(work)).toBe("once");
  let revision = 0;
  await expect.poll(async () => { const response = await f.detail(work); if (response.status !== 200) return false; const value = await response.json(); revision = value.workflow?.revision ?? 0; return value.workflow?.state === "running"; }, { timeout: 15000 }).toBe(true);
  const stopped = await f.cliStop(work, revision); expect(stopped.code, stopped.stderr).toBe(0);
  expect(JSON.parse(stopped.stdout)).toMatchObject({ workId: work.work_id, requestId: stopped.requestId, stopRequested: true, status: "stop_requested" });
  expect(stopped.stderr).toContain(stopped.requestId); expect(f.childAlive(work)).toBe(true); expect(f.reservation(work)).toMatchObject({ state: "held" });
  await expect.poll(() => f.receipt(work)?.physical_state, { timeout: 15000 }).toBe("ceased");
  expect(f.receipt(work)).toMatchObject({ physical_state: "ceased", effect_certainty: "uncertain", outcome: "uncertain" });
  expect(f.childAlive(work)).toBe(false); await expect.poll(() => f.reservation(work)?.state, { timeout: 5000 }).toBe("released");
  expect(f.effects(work)).toBe("once"); expect(f.stopAudits(work)).toHaveLength(1);
}), 90_000);

it("keeps already accepted native work running after ordinary caller-session closure while refusing another Stop from that session", async () => scenario(async f => {
  const work = await f.accept(f.request("closed-caller-native", "wait"));
  await expect.poll(() => f.childAlive(work), { timeout: 20000 }).toBe(true);
  const detail = await f.detail(work); expect(detail.status).toBe(200); const revision = (await detail.json()).workflow.revision;
  const before = f.leaseUntil(work); expect(before).toBeGreaterThan(0);
  await f.endSession();
  expect((await f.stop(work, revision)).status).toBe(403);
  await expect.poll(() => f.leaseUntil(work), { timeout: 15000 }).toBeGreaterThan(before);
  expect(f.childAlive(work)).toBe(true); expect(f.reservation(work)).toMatchObject({ state: "held" }); expect(f.receipt(work)).toBeNull();
  expect(f.effects(work)).toBe("once"); expect(f.stopAudits(work)).toHaveLength(0);
  expect((await f.lookup(work.idempotency_key)).status).toBe(200);
}), 90_000);

it("runs identity work through managed service entry using only manifest-declared installation overrides", async () => scenario(async f => {
  const definitions = z.record(z.string(), z.object({ env: z.array(z.object({ name: z.string(), source: z.literal("value"), value: z.string() })) })).parse(f.managedDefinitions());
  // Prepared specs retain manifest defaults; installation configuration supplies their values at execve.
  for (const name of ["BARRY_WORKFLOW_DELEGATION_KEYS", "BARRY_WORKFLOW_SCRIPT_RESOURCES", "BARRY_WORKFLOW_ACTION_PROJECTIONS"])
    expect(definitions["workflows.runtime"].env).toContainEqual({ name, source: "value", value: "" });
  expect(definitions["sessions.api"].env).toContainEqual({ name: "BARRY_WORKFLOW_DELEGATION_KEYS", source: "value", value: "" });
  const undeclared = await f.rejectManagedConfiguration("workflows.runtime", ["UNDECLARED_WORK_SETTING=private-rejected-canary"]);
  expect(undeclared.code).toBe(1); expect(undeclared.stderr).toContain("UNDECLARED_WORK_SETTING is not a declared nonsecret value");
  expect(undeclared.stdout + undeclared.stderr).not.toContain("private-rejected-canary");
  const malformed = await f.rejectManagedConfiguration("sessions.api", ["BARRY_WORKFLOW_DELEGATION_KEYS"]);
  expect(malformed.code).toBe(1); expect(malformed.stderr).toContain("KEY=VALUE");
  expect(f.ownerRows()).toHaveLength(0); expect(f.relayState.submissions).toBe(0); expect(f.effectFiles()).toHaveLength(0);

  const request = f.request("managed-identity-finish");
  const started = await f.cli(["work-start", "fixtureinstalled:probe", "--session", "owned", "--key", request.idempotency_key, "--request-id", request.request_id, "--input-json", JSON.stringify(request.inputs)]);
  expect(started.code, started.stderr).toBe(0); const work = fromCli(JSON.parse(started.stdout));
  await expect.poll(async () => (await f.workResult(work)).outcome?.ok, { timeout: 20000 }).toBe(true);
  expect((await f.workResult(work)).outcome).toEqual({ ok: true, value: { credential_digest: f.expectedCredentialDigest, id: work.run_id } });
  const recovered = await f.cli(["work-lookup", request.idempotency_key, "--session", "owned"]);
  expect(recovered.code, recovered.stderr).toBe(0); expect(fromCli(JSON.parse(recovered.stdout))).toEqual({ ...work, created: false });
  expect(f.effects(work)).toBe("once");

  const nativeRequest = f.request("managed-identity-native", "wait");
  const native = await f.cli(["work-start", "fixtureinstalled:probe", "--session", "owned", "--key", nativeRequest.idempotency_key, "--input-json", JSON.stringify(nativeRequest.inputs)]);
  expect(native.code, native.stderr).toBe(0); const running = fromCli(JSON.parse(native.stdout));
  await expect.poll(() => f.childAlive(running), { timeout: 20000 }).toBe(true);
  let revision = 0;
  await expect.poll(async () => { const response = await f.detail(running); if (response.status !== 200) return false; const value = await response.json(); revision = value.workflow?.revision ?? 0; return value.workflow?.state === "running"; }, { timeout: 15000 }).toBe(true);
  const stopped = await f.cliStop(running, revision); expect(stopped.code, stopped.stderr).toBe(0);
  expect(JSON.parse(stopped.stdout)).toMatchObject({ workId: running.work_id, stopRequested: true });
  expect(f.childAlive(running)).toBe(true); expect(f.reservation(running)).toMatchObject({ state: "held" });
  await expect.poll(() => f.receipt(running)?.physical_state, { timeout: 15000 }).toBe("ceased");
  expect(f.receipt(running)).toMatchObject({ physical_state: "ceased", effect_certainty: "uncertain", outcome: "uncertain" });
  expect(f.childAlive(running)).toBe(false); await expect.poll(() => f.reservation(running)?.state, { timeout: 5000 }).toBe("released");
  expect(f.effects(running)).toBe("once"); expect(f.stopAudits(running)).toHaveLength(1); expect(f.ownerRows()).toHaveLength(2);
}, { managedEntry: true }), 90_000);
