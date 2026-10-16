import { expect, it } from "vitest";
import type { AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import { foreignInstallationPrincipal, workflowInstalledAuthority } from "../../test/fixtures/workflow-installed-authority.js";

type Fixture = Awaited<ReturnType<typeof workflowInstalledAuthority>>;
async function using(run: (fixture: Fixture) => Promise<void>) {
  const f = await workflowInstalledAuthority(), errors: unknown[] = [];
  try { await run(f); } catch (error) { errors.push(error); }
  try { await f.close(errors.length > 0); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "Installed authority fixture failed; preserved " + f.root);
}

it("runs actual registered Pi with owned session authority and private declared provider credentials, then reads replay after key/model removal", async () => {
  await using(async f => {
    expect(f.toolDefinitions).toEqual([]);
    const request = f.request(), session = await f.manager.prepare(request), turn = request.key + "/turn";
    expect(f.requests).toHaveLength(0);expect(session.declaration.identity).toBe(f.identity);
    f.endOrigin();expect(await session.start(turn, "Return the installed authority result")).toBe(f.result);
    expect(f.requests).toHaveLength(1);expect(f.requests[0].phase).toBe("input");expect(f.providerErrors).toEqual([]);
    expect(await session.lookup(turn)).toMatchObject({ state: "complete", result: JSON.stringify(f.result) });
    expect(await session.start(turn, "Return the installed authority result")).toBe(f.result);expect(f.requests).toHaveLength(1);
    const declarations = JSON.stringify(f.declarations());expect(declarations).not.toContain(f.selectedKey);expect(declarations).not.toContain("selected-harness-only");expect(declarations).not.toContain("UNRELATED_SECRET");
    // Explicit coordinator commit-loss simulation. Actual completed turn and
    // strict native cessation remain; this is not an owner-death experiment.
    f.sessionDb.prepare("UPDATE session_workflow_turns SET state='uncertain',result=NULL WHERE key=?").run(turn);
    expect(f.sessionDb.prepare("SELECT state,result FROM session_workflow_turns WHERE key=?").get(turn)).toEqual({ state: "uncertain", result: null });
    f.writeSecrets(false);f.emptyModels();await f.reopen();
    const restored = await f.manager.open({ key: request.key, principal: f.principal, identity: f.identity });
    expect(await restored.lookup(turn)).toMatchObject({ state: "complete", result: JSON.stringify(f.result) });
    expect(await restored.start(turn, "Return the installed authority result")).toBe(f.result);expect(f.requests).toHaveLength(1);
    const fences = f.sessionDb.prepare("SELECT phase,handle_json FROM session_workflow_settlements").all() as { phase: string; handle_json: string }[];
    expect(fences).toHaveLength(1);expect(fences[0].phase).toBe("ceased");
    const { pgid } = JSON.parse(fences[0].handle_json);
    expect(() => process.kill(-pgid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
}, 180000);

it("refuses actual foreign/device/ended/nested origins and cross-binding journal access before provider input", async () => {
  await using(async f => {
    const device: AuthPrincipal = { kind: "device", actorId: 1, credentialId: "device", identityIds: [42], scopes: ["sessions:turn"] };
    for (const overrides of [
      { principal: foreignInstallationPrincipal }, { principal: device }, { callerSessionId: "foreign", identity: f.foreignIdentity },
      { callerSessionId: "ended" }, { callerSessionId: "nested" }, { callerSessionId: "missing" }, { bags: ["unselected-bag"] },
    ]) await expect(f.manager.prepare(f.request(undefined, overrides))).rejects.toThrow();
    const first = await f.manager.prepare(f.request()), second = await f.manager.prepare(f.request());
    const otherTurn = "other-destination-turn";
    f.sessionDb.prepare("INSERT INTO session_workflow_turns(key,session_id,request_hash,state,result) VALUES(?,?,?,'admitted',NULL)").run(otherTurn, second.declaration.sessionId, "a".repeat(64));
    const before = f.sessionDb.prepare("SELECT * FROM session_workflow_turns WHERE key=?").get(otherTurn);
    await expect(first.lookup(otherTurn)).rejects.toThrow("WorkflowTurnBindingConflict");
    await expect(first.interrupt(otherTurn)).rejects.toThrow("WorkflowTurnBindingConflict");
    expect(f.sessionDb.prepare("SELECT * FROM session_workflow_turns WHERE key=?").get(otherTurn)).toEqual(before);
    expect(f.requests).toHaveLength(0);expect(f.sessionDb.prepare("SELECT count(*) AS count FROM session_workflow_destinations").get()).toEqual({ count: 0 });
  });
}, 180000);

it("refuses missing real declared identity keys despite same-name ambient credentials before any destination input", async () => {
  await using(async f => {
    f.writeSecrets(false);await expect(f.manager.prepare(f.request())).rejects.toThrow("WorkflowDeclaredCredentialsUnavailable");
    expect(f.requests).toHaveLength(0);expect(f.sessionDb.prepare("SELECT count(*) AS count FROM session_workflow_settlements").get()).toEqual({ count: 0 });
  });
}, 180000);


it("refuses an unexpected provider native write without an effect or a successor model request", async () => {
  await using(async f => {
    f.unexpectedToolResponse();
    const request = f.request(), session = await f.manager.prepare(request), turn = request.key + "/unexpected-tool";
    // The actual destination uses automatic review. An unsolicited tool must
    // not turn that bound into permission to run a tool or another model round.
    const outcome = await session.start(turn, "Return one tool-free answer").then(value => ({ value }), error => ({ error }));
    expect(outcome).toHaveProperty("error");expect(f.requests).toHaveLength(1);
    expect((f.requests[0].body as { tools?: unknown[] }).tools ?? []).toEqual([]);
    expect(f.hasUnexpectedEffect()).toBe(false);expect(f.providerErrors).toEqual([]);
    await session.interrupt(turn);
    expect(f.requests).toHaveLength(1);expect(f.hasUnexpectedEffect()).toBe(false);
    const fences = f.sessionDb.prepare("SELECT turn_id,phase,handle_json,input_at,ceased_at FROM session_workflow_settlements ORDER BY rowid").all() as {
      turn_id: string; phase: string; handle_json: string | null; input_at: string | null; ceased_at: string | null;
    }[];
    // The over-budget successor is excluded before native preparation. Require
    // that positive proof, rather than a native handle for an unlaunched turn.
    expect(fences).toHaveLength(2);
    const [first, successor] = fences;
    expect(first).toMatchObject({ phase: "ceased", handle_json: expect.any(String), input_at: expect.any(String), ceased_at: expect.any(String) });
    expect(successor).toMatchObject({ turn_id: first!.turn_id, phase: "not_started", handle_json: null, input_at: null, ceased_at: expect.any(String) });
    for (const fence of fences) expect(Number.isFinite(Date.parse(fence.ceased_at!))).toBe(true);
    const { pid, pgid } = JSON.parse(first!.handle_json!);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);expect(pgid).toBe(pid);
    expect(() => process.kill(-pgid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
}, 180000);


it("rechecks actual origin authority after preparation and refuses missing activation keys without input", async () => {
  await using(async f => {
    for (const kind of ["bags", "bound", "actor", "identity", "identity-deletion"] as const) {
      const request = f.request(), session = await f.manager.prepare(request), restore = f.changeAuthority(kind);
      try { await expect(session.start(request.key + "/revoked", "Must not reach the provider")).rejects.toThrow(); }
      finally { restore(); }
      expect(f.requests).toHaveLength(0);
      expect(f.sessionDb.prepare("SELECT count(*) AS count FROM session_workflow_settlements WHERE input_at IS NOT NULL").get()).toEqual({ count: 0 });
    }
    const request = f.request(), session = await f.manager.prepare(request);f.writeSecrets(false);
    await expect(session.start(request.key + "/missing-activation-key", "Must not use ambient credentials")).rejects.toThrow();
    expect(f.requests).toHaveLength(0);expect(f.providerErrors).toEqual([]);
    const fences = f.sessionDb.prepare("SELECT phase,handle_json,input_at FROM session_workflow_settlements").all() as { phase: string; handle_json: string; input_at: string | null }[];
    expect(fences.length).toBeGreaterThan(0);
    for (const fence of fences) {
      expect(fence.phase).toBe("ceased");expect(fence.input_at).toBeNull();
      const { pgid } = JSON.parse(fence.handle_json);
      expect(() => process.kill(-pgid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
  });
}, 180000);

it("rereads a real declared provider key rotated after preparation before releasing model input", async () => {
  await using(async f => {
    const request = f.request(), session = await f.manager.prepare(request), originalKey = f.selectedKey;
    f.writeSecrets(true, originalKey + "-rotated");
    expect(await session.start(request.key + "/rotated", "Return the selected identity answer")).toBe(f.result);
    expect(f.requests).toHaveLength(1);expect(f.requests[0].authorization).toBe("Bearer " + f.selectedKey);
    expect(f.requests[0].authorization).not.toBe("Bearer " + originalKey);expect(f.providerErrors).toEqual([]);
    const serialized = JSON.stringify(f.declarations());expect(serialized).not.toContain(originalKey);expect(serialized).not.toContain(f.selectedKey);
    const fences = f.sessionDb.prepare("SELECT phase,handle_json,input_at FROM session_workflow_settlements").all() as { phase: string; handle_json: string; input_at: string | null }[];
    expect(fences).toHaveLength(1);expect(fences[0].phase).toBe("ceased");expect(fences[0].input_at).not.toBeNull();
    const { pgid } = JSON.parse(fences[0].handle_json);expect(() => process.kill(-pgid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
}, 180000);


it("drains an actual active owner before evaluating a standby handle for the same binding during manager close", async () => {
  await using(async f => {
    f.holdProvider();
    const request = f.request(), owner = await f.manager.prepare(request), turn = request.key + "/held-provider";
    // Attach rejection handling immediately: manager close intentionally
    // interrupts this actual in-flight provider stream.
    const running = owner.start(turn, "Wait for shutdown").then(value => ({ value }), error => ({ error }));
    await f.waitForProviderRequest();
    expect(f.requests).toHaveLength(1);expect(f.requests[0].phase).toBe("input");
    const active = f.sessionDb.prepare("SELECT phase,input_at,handle_json FROM session_workflow_settlements WHERE ceased_at IS NULL").all() as { phase: string; input_at: string | null; handle_json: string }[];
    expect(active.length).toBeGreaterThan(0);expect(active.some(fence => fence.phase === "input" && fence.input_at !== null)).toBe(true);
    const standby = await f.manager.open({ key: request.key, principal: f.principal, identity: f.identity });
    expect(standby.declaration.sessionId).toBe(owner.declaration.sessionId);
    await expect(f.manager.close()).resolves.toBeUndefined();await running;
    expect(f.requests).toHaveLength(1);expect(f.providerErrors).toEqual([]);expect(f.hasUnexpectedEffect()).toBe(false);
    const fences = f.sessionDb.prepare("SELECT phase,handle_json FROM session_workflow_settlements").all() as { phase: string; handle_json: string }[];
    expect(fences.length).toBeGreaterThan(0);expect(fences.every(fence => fence.phase === "ceased")).toBe(true);
    for (const fence of fences) {
      const { pgid } = JSON.parse(fence.handle_json);expect(() => process.kill(-pgid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
  });
}, 180000);
