import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { encryptedIdentityVault } from "../../test/fixtures/encrypted-identity-vault.js";
import { installedIdentityWork } from "../../../bags/sessions/api/src/testing/installed-identity-work.js";

const accepted = z.object({ run_id: z.string(), work_id: z.string(), workflow_id: z.string(), idempotency_key: z.string(), created: z.boolean() });
const cliAccepted = z.object({ runId: z.string(), workId: z.string(), workflowId: z.string(), idempotencyKey: z.string(), created: z.boolean() });
function fromCli(stdout: string) {
  const value = cliAccepted.parse(JSON.parse(stdout));
  return accepted.parse({ run_id: value.runId, work_id: value.workId, workflow_id: value.workflowId, idempotency_key: value.idempotencyKey, created: value.created });
}

it("resolves persisted selected identities through distinct real encrypted accounts with identical item names", async () => {
  const f = await encryptedIdentityVault();
  try {
    const rows = f.encryptedRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.account_id)).size).toBe(2);
    for (const row of rows) {
      expect(row.name).not.toBe(f.item);
      expect(row.password).not.toBe(f.canaries.a);
      expect(row.password).not.toBe(f.canaries.b);
    }
    for (const method of ["GET", "PUT", "DELETE"]) expect((await f.crossAccount(method)).status).toBe(404);
    expect((await f.client.getItem(f.authB, f.item)).password).toBe(f.canaries.b);
    const baseline = f.revokedCount();
    expect(await f.resolve([42, 43, 42])).toEqual([
      { id: 42, keys: ["SCRIPT_KEY"], digest: f.expectedA },
      { id: 43, keys: ["SCRIPT_KEY"], digest: f.expectedB },
      { id: 42, keys: ["SCRIPT_KEY"], digest: f.expectedA },
    ]);
    expect(await f.resolve([42, 43], true)).toEqual([
      { id: 42, keys: ["SCRIPT_KEY"], digest: f.expectedA },
      { id: 43, keys: ["SCRIPT_KEY"], digest: f.expectedB },
    ]);
    expect(f.revokedCount()).toBe(baseline + 5);
    await f.restart();
    expect(await f.resolve([42, 43])).toEqual([
      { id: 42, keys: ["SCRIPT_KEY"], digest: f.expectedA },
      { id: 43, keys: ["SCRIPT_KEY"], digest: f.expectedB },
    ]);
    expect(f.revokedCount()).toBe(baseline + 7);
    // Seeded child metadata was composed by the production mergeInheritedIdentity API.
    // An inherited reference never supplies its parent's vault automatically.
    const children = await f.resolve([44, 45]);
    expect(children[0]).toMatchObject({ id: 44, error: expect.any(String) });
    expect(children[0]).not.toHaveProperty("digest");
    expect(children[1]).toEqual({ id: 45, keys: ["SCRIPT_KEY"], digest: f.expectedB });
    expect(f.revokedCount()).toBe(baseline + 8);
    await f.deleteA();
    const denied = await f.resolve([42, 43]);
    expect(denied[0]).toMatchObject({ id: 42, error: expect.any(String) });
    expect(denied[0]).not.toHaveProperty("digest");
    expect(denied[1]).toEqual({ id: 43, keys: ["SCRIPT_KEY"], digest: f.expectedB });
    // The failed item read must close its real authenticated session too.
    expect(f.revokedCount()).toBe(baseline + 10);
    for (const value of [f.item, f.canaries.a, f.canaries.b]) expect(f.persistentBytes().includes(Buffer.from(value))).toBe(false);
    for (const value of [f.canaries.a, f.canaries.b]) expect(JSON.stringify({ denied, diagnostics: f.diagnostics() })).not.toContain(value);
  } finally { await f.close(); }
}, 60_000);

it("refuses wrong or missing selected encrypted-account bootstrap while another account remains healthy", async () => {
  const f = await encryptedIdentityVault();
  try {
    for (const [field, value] of [["email", null], ["email", "wrong-selected-email@fixture.invalid"], ["master_password", null], ["master_password", "wrong-selected-master-password"]] as const) {
      f.setBootstrapA(field, value);
      const before = f.revokedCount();
      const [denied] = await f.resolve([42]);
      // Wrong email/password still receives a real API-key token before unwrap fails.
      // The client must revoke that unusable bearer; missing bootstrap never authenticates.
      expect(f.revokedCount()).toBe(before + (value === null ? 0 : 1));
      const [healthy] = await f.resolve([43]);
      expect(f.revokedCount()).toBe(before + (value === null ? 1 : 2));
      expect(denied).toMatchObject({ id: 42, error: "$SCRIPT_KEY: could not open the declared vault" });
      expect(denied).not.toHaveProperty("digest");
      expect(healthy).toEqual({ id: 43, keys: ["SCRIPT_KEY"], digest: f.expectedB });
      for (const canary of [f.canaries.a, f.canaries.b, value].filter((item): item is string => item !== null)) expect(JSON.stringify(denied)).not.toContain(canary);
      f.resetBootstrap();
    }
    expect(await f.resolve([42])).toEqual([{ id: 42, keys: ["SCRIPT_KEY"], digest: f.expectedA }]);
  } finally { await f.close(); }
}, 60_000);

it("admits and executes the installed identity script using its canonical encrypted account and refuses missing selected credentials without another account fallback", async () => {
  const installed = await installedIdentityWork({ managedEntry: true });
  let vault: Awaited<ReturnType<typeof encryptedIdentityVault>> | undefined;
  let failure: unknown;
  try {
    vault = await encryptedIdentityVault({ home: installed.home });
    const request = installed.request("encrypted-installed-owner");
    const result = await installed.cli(["work-start", "fixtureinstalled:probe", "--session", "owned", "--key", request.idempotency_key,
      "--request-id", request.request_id, "--input-json", JSON.stringify(request.inputs)]);
    expect(result.code, result.stderr).toBe(0);
    const work = fromCli(result.stdout);
    await expect.poll(async () => (await installed.workResult(work)).outcome?.ok, { timeout: 20000 }).toBe(true);
    expect((await installed.workResult(work)).outcome).toEqual({ ok: true, value: { credential_digest: vault.expectedA, id: work.run_id } });
    expect(installed.effects(work)).toBe("once");
    expect(installed.ownerRows()).toHaveLength(1);
    const admission = JSON.parse(String((installed.ownerRows()[0] as { record: string }).record));
    expect(admission).toMatchObject({ namespace: { principal_kind: "identity", principal_id: installed.identity, identity_id: installed.identity, caller_session_id: "owned" },
      plan: { process_program: { credential_owner: { kind: "identity", identity: installed.identity }, secret_names: ["SCRIPT_KEY"] } } });
    expect(await vault.resolve([43])).toEqual([{ id: 43, keys: ["SCRIPT_KEY"], digest: vault.expectedB }]);
    await vault.deleteA();
    const recovered = await installed.cli(["work-lookup", request.idempotency_key, "--session", "owned"]);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(fromCli(recovered.stdout)).toEqual({ ...work, created: false });
    expect(installed.effects(work)).toBe("once");
    const refusal = await installed.submit(installed.request("encrypted-selected-item-missing"));
    expect(refusal.status).toBe(409);
    const refusalBody = await refusal.json();
    expect(refusalBody.code ?? refusalBody.error).toBe("WorkCredentialsUnavailable");
    expect(refusalBody.admission_disposition).toBe("refused");
    expect(installed.ownerRows()).toHaveLength(1);
    expect(installed.effectFiles()).toHaveLength(1);
    expect(installed.effects(work)).toBe("once");
    expect(await vault.resolve([43])).toEqual([{ id: 43, keys: ["SCRIPT_KEY"], digest: vault.expectedB }]);
    const publicEvidence = JSON.stringify({ admission: installed.ownerRows(), execution: installed.execution(work), result: await installed.workResult(work), diagnostics: installed.diagnostics(), vault: vault.diagnostics() });
    for (const secret of [vault.canaries.a, vault.canaries.b]) expect(publicEvidence).not.toContain(secret);
  } catch (error) { failure = error; }
  // Stop runtime consumers before the daemon; attempt both cleanups and preserve all failures.
  for (const close of [() => installed.close(), () => vault?.close()]) {
    try { await close(); } catch (error) { failure = failure ? new AggregateError([failure, error], "Encrypted installed scenario/cleanup failed") : error; }
  }
  if (failure) throw failure;
}, 90_000);


it("rereads a rotated selected encrypted credential when real native capacity becomes available after acceptance", async () => {
  const installed = await installedIdentityWork({ managedEntry: true, capacity: 1 });
  let vault: Awaited<ReturnType<typeof encryptedIdentityVault>> | undefined;
  let failure: unknown;
  try {
    vault = await encryptedIdentityVault({ home: installed.home });
    const encrypted = vault;
    const blocker = await installed.accept(installed.request("encrypted-capacity-blocker", "wait"));
    await expect.poll(() => installed.childAlive(blocker), { timeout: 20000 }).toBe(true);
    expect(installed.reservation(blocker)).toMatchObject({ state: "held" });
    let revision = 0;
    await expect.poll(async () => {
      const response = await installed.detail(blocker);
      if (response.status !== 200) return false;
      const value = await response.json();revision = value.workflow?.revision ?? 0;
      return value.workflow?.state === "running" && revision > 0;
    }, { timeout: 15000 }).toBe(true);
    const queued = await installed.accept(installed.request("encrypted-capacity-queued"));
    // A real durable pending activity with no worker attempt proves the capacity boundary.
    // No lifecycle rows, physical observations or grants are inserted to manufacture waiting.
    await expect.poll(() => encrypted.pendingActivities(queued.workflow_id).length, { timeout: 15000 }).toBeGreaterThan(0);
    expect(installed.execution(queued)).toBeUndefined();
    expect(installed.effects(queued)).toBe("");
    expect(installed.childAlive(blocker)).toBe(true);
    expect(installed.reservation(blocker)).toMatchObject({ state: "held" });
    const rotated = "rotated-encrypted-launch-" + randomUUID(), expected = await encrypted.rotateA(rotated);
    const stopped = await installed.cliStop(blocker, revision);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ workId: blocker.work_id, stopRequested: true });
    await expect.poll(() => installed.receipt(blocker)?.physical_state, { timeout: 15000 }).toBe("ceased");
    await expect.poll(() => installed.reservation(blocker)?.state, { timeout: 5000 }).toBe("released");
    await expect.poll(async () => (await installed.workResult(queued)).outcome?.ok, { timeout: 20000 }).toBe(true);
    expect((await installed.workResult(queued)).outcome).toEqual({ ok: true, value: { credential_digest: expected, id: queued.run_id } });
    expect(expected).not.toBe(encrypted.expectedA);
    expect(installed.effects(queued)).toBe("once");expect(installed.effects(blocker)).toBe("once");
    expect(installed.ownerRows()).toHaveLength(2);
    const retained = JSON.stringify({ records: installed.ownerRows(), execution: installed.execution(queued), result: await installed.workResult(queued) });
    for (const secret of [rotated, encrypted.canaries.a, encrypted.canaries.b]) expect(retained).not.toContain(secret);
  } catch (error) { failure = error; }
  for (const close of [() => installed.close(), () => vault?.close()]) {
    try { await close(); } catch (error) { failure = failure ? new AggregateError([failure, error], "Encrypted queued scenario/cleanup failed") : error; }
  }
  if (failure) throw failure;
}, 90_000);
