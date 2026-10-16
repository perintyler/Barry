import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { writeServiceRegistry } from "@barry-rocks/sdk/services";
import { CLI_TARGET, applyCommandTarget } from "../target.js";
import { callWork, registerWork, startOperatorWork } from "./work.js";

it("submits with a dedicated CLI issuer, recovers a lost real HTTP reply and exposes matching read/stop commands", async () => {
  const home = process.env.BARRY_HOME!;
  const keys = join(home, "work-keys.json"), snapshot = join(home, "work-snapshot.json");
  const job = join(home, "cli-job-fixture"); mkdirSync(job);
  writeFileSync(join(job, "bag.yaml"), JSON.stringify({ name: "fixturecli", description: "Disposable CLI job", bounds: { "no-files": { description: "No file access", files: { allow: [] }, nodes: { allow: ["local"] } } }, jobs: { run: { description: "Return a value", version: 1, bounds: ["fixturecli:no-files"], runs: { using: "node", main: "main.mjs" }, input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, output_schema: { type: "object" }, timeout: "5s" } } }));
  writeFileSync(join(job, "main.mjs"), 'const input=JSON.parse(process.getBuiltinModule("node:fs").readFileSync(0,"utf8"));process.stderr.write("CLI retained diagnostic");process.stdout.write(JSON.stringify({value:input.value}));');
  writeFileSync(snapshot, JSON.stringify({ bags: { workflows: { type: "local", path: fileURLToPath(new URL("../../../bags/workflows/", import.meta.url)) }, fixturecli: { type: "local", path: job } } }));
  writeFileSync(keys, JSON.stringify({ "workflows.cli.operator": [{ id: "cli", secret: "fixture-only-dedicated-cli-operator-key", not_before: Date.now() - 1000, not_after: Date.now() + 3600000 }] }), { mode: 0o600 });
  const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../../bags/workflows/runtime/src/service.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, BARRY_HOME: home, BARRY_SECRET: "work-cli-secret", BARRY_WORKFLOW_DELEGATION_KEYS: keys, BARRY_BAGS_SNAPSHOT: snapshot, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise(resolve => child.once("exit", resolve)); let output = "", errors = "";
  child.stdout.on("data", data => { output += String(data); }); child.stderr.on("data", data => { errors += String(data); });
  const originalSecret = process.env.BARRY_SECRET, nativeFetch = globalThis.fetch;
  process.env.BARRY_SECRET = "work-cli-secret";
  try {
    await expect.poll(() => output + errors, { timeout: 15000 }).toContain("runtime ready");
    writeServiceRegistry({ version: 2, generated: new Date().toISOString(), resources: { "workflows.runtime": { bag: "workflows", name: "runtime", kind: "service", url: `http://127.0.0.1:${port}` } } });
    let lost = false;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await nativeFetch(input, init);
      if (String(input).endsWith("/api/v2/work/submissions") && !lost) { lost = true; throw new Error("real accepted HTTP reply lost"); }
      return response;
    });
    const input = { inputJson: JSON.stringify({ message: "CLI retained output" }), key: "cli-lost-reply", delegationKeys: keys };
    const report = vi.fn();
    await expect(startOperatorWork("echo", input, report)).rejects.toThrow(/work lookup/);
    const accepted = await callWork("/api/v2/work/operations?key=cli-lost-reply") as { work_id: string; workflow_id: string };
    const retried = await startOperatorWork("echo", input, report); expect(retried.work_id).toBe(accepted.work_id);
    await expect.poll(async () => (await callWork(`/api/v2/work/${accepted.work_id}`) as { state: string }).state, { timeout: 15000 }).toBe("completed");
    const result = await callWork(`/api/v2/work/${accepted.work_id}/result`) as { outcome: unknown };
    expect(result.outcome).toEqual({ ok: true, value: "CLI retained output" });
    const detail = await callWork(`/api/runs/${accepted.workflow_id}`) as { commands: { id: string }[] };
    const command = await callWork(`/api/runs/${accepted.workflow_id}/command?id=${encodeURIComponent(detail.commands[0].id)}`) as { attempts: unknown[] };
    expect(command.attempts).toHaveLength(1); expect(report).toHaveBeenCalledWith("Submission key: cli-lost-reply");
    const wait = await startOperatorWork("echo", { ...input, key: "cli-stop", inputJson: JSON.stringify({ message: "never launch", delayMs: 60000 }) }, report);
    const log = vi.spyOn(console, "log").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
    const program = new Command().exitOverride(); registerWork(program);
    await program.parseAsync(["work", "start", "fixturecli:run@1", "--kind", "job", "--input-json", '{"value":"CLI node job"}', "--key", "cli-node-job", "--delegation-keys", keys], { from: "user" });
    const nodeJob = JSON.parse(String(log.mock.calls.at(-1)![0]));
    await expect.poll(async () => (await callWork(`/api/v2/work/${nodeJob.work_id}`) as { state: string }).state, { timeout: 15000 }).toBe("completed");
    await program.parseAsync(["work", "result", nodeJob.work_id], { from: "user" });
    const nodeResult = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(nodeResult.outcome).toEqual({ ok: true, value: { value: "CLI node job" } });
    expect(nodeResult.logs[0]).toMatchObject({ stage: "execution", value: { stderr: "CLI retained diagnostic" } });
    await program.parseAsync(["work", "evidence", accepted.work_id], { from: "user" });
    const evidence = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(evidence.receipts).toHaveLength(1); expect(evidence.receipts[0].outcome).toBe("complete"); expect(evidence.audit).toEqual([]);
    await expect(program.parseAsync(["work", "reconcile", accepted.work_id, "--revision", String(evidence.revision), "--attempt", evidence.receipts[0].attempt_id,
      "--receipt-digest", evidence.receipts[0].receipt_digest, "--reason", "Cannot replace a terminal decision", "--residual-risk", "No replacement launch permitted"], { from: "user" })).rejects.toThrow(/terminal decisions remain unchanged/);
    expect((await callWork(`/api/v2/work/${accepted.work_id}`) as { state: string }).state).toBe("completed");
    await program.parseAsync(["work", "show", wait.work_id], { from: "user" });
    const current = JSON.parse(String(log.mock.calls.at(-1)![0])) as { revision: number };
    const args = ["work", "stop", wait.work_id, "--revision", String(current.revision), "--request-id", "3b2e0475-2040-4085-8e3c-1ceda276883d"];
    await program.parseAsync(args, { from: "user" }); const ack = JSON.parse(String(log.mock.calls.at(-1)![0])); expect(ack.stop_requested).toBe(true);
    await program.parseAsync(args, { from: "user" }); expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toEqual(ack);
    await program.parseAsync(["work", "result", wait.work_id], { from: "user" }); expect(JSON.parse(String(log.mock.calls.at(-1)![0])).outcome.error.code).toBe("Cancelled");
    log.mockRestore(); error.mockRestore();
  } finally {
    vi.unstubAllGlobals(); if (originalSecret === undefined) delete process.env.BARRY_SECRET; else process.env.BARRY_SECRET = originalSecret;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited;
  }
}, 45000);

it("never elevates an identity CLI into operator work or reads its credentials", async () => {
  const previous = Reflect.get(globalThis, CLI_TARGET), fetch = vi.spyOn(globalThis, "fetch");
  Reflect.set(globalThis, CLI_TARGET, { kind: "identity", binding: { id: 7, home: null }, name: "alice" });
  try {
    await expect(callWork("/api/v2/work")).rejects.toThrow(/unavailable in an identity CLI/);
    await expect(startOperatorWork("echo", { inputJson: "{}", delegationKeys: "/must-not-read" })).rejects.toThrow(/unavailable in an identity CLI/);
    expect(fetch).not.toHaveBeenCalled();
    const program = new Command(); registerWork(program); applyCommandTarget(program, { kind: "identity", binding: { id: 7, home: null }, name: "alice" });
    expect(program.commands.some(command => command.name() === "work")).toBe(false);
  } finally { fetch.mockRestore(); Reflect.set(globalThis, CLI_TARGET, previous); }
});

it("refuses an explicit identity selection on the operator command before making a request", async () => {
  const fetch = vi.spyOn(globalThis, "fetch"), program = new Command().exitOverride().option("--identity <identity>");
  registerWork(program);
  try { await expect(program.parseAsync(["--identity", "alice", "work", "list"], { from: "user" })).rejects.toThrow(/cannot use --identity/); expect(fetch).not.toHaveBeenCalled(); }
  finally { fetch.mockRestore(); }
});


it("binds CLI reconciliation to reviewed evidence and preserves the request UUID after a lost reply", async () => {
  const oldSecret = process.env.BARRY_SECRET; process.env.BARRY_SECRET = "fixture-operator-secret";
  const log = vi.spyOn(console, "log").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
  const requests: { path: string; body: unknown }[] = []; let lost = true;
  vi.stubGlobal("fetch", async (input: unknown, init: RequestInit) => {
    const path = new URL(String(input)).pathname, body = init.body ? JSON.parse(String(init.body)) : undefined; requests.push({ path, body });
    if (body && lost) { lost = false; throw new Error("reply lost"); }
    return Response.json(body ? { request_id: body.request_id, receipt_digest: body.receipt_digest } : { receipts: [], audit: [] });
  });
  try {
    const program = new Command().exitOverride(); registerWork(program);
    await program.parseAsync(["work", "evidence", "work-1"], { from: "user" }); expect(requests[0]).toEqual({ path: "/api/v2/work/work-1/reconciliation", body: undefined });
    const args = ["work", "reconcile", "work-1", "--revision", "42", "--attempt", "attempt-1", "--receipt-digest", "a".repeat(64), "--reason", "Reviewed retained evidence", "--residual-risk", "Known original effects only", "--request-id", "fae7af55-ad99-4a5f-8bf7-4fe2b2b05439"];
    await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(/same inputs and --request-id fae7af55/);
    await program.parseAsync(args, { from: "user" }); expect(requests[2]).toEqual(requests[1]);
    expect(requests[2].body).toMatchObject({ expected_revision: 42, attempt_id: "attempt-1", reason: "Reviewed retained evidence", residual_risk: "Known original effects only" });
    expect(log).toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); log.mockRestore(); error.mockRestore(); if (oldSecret === undefined) delete process.env.BARRY_SECRET; else process.env.BARRY_SECRET = oldSecret; }
});

it("requires explicit activation attestations and reuses the exact CLI request after a lost reply", async () => {
  const oldSecret = process.env.BARRY_SECRET; process.env.BARRY_SECRET = "activation-fixture-secret";
  const epoch = "fae7af55-ad99-4a5f-8bf7-4fe2b2b05439", requests: unknown[] = [], log = vi.spyOn(console, "log").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {}); let lost = true;
  vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined; if (!body) return Response.json({ recovery: { epoch, active: !lost } });
    requests.push(body); if (lost) { lost = false; throw new Error("activation reply lost"); } return Response.json({ epoch, request_id: body.request_id, admission_active: true });
  });
  try {
    const program = new Command().exitOverride(); registerWork(program); await program.parseAsync(["work", "recovery"], { from: "user" });
    const args = ["work", "activate-admission", "--epoch", epoch, "--request-id", "c7e6eb20-d9cf-4d76-8b5c-6b54a88931c0", "--reason", "Reviewed surviving effects", "--residual-risk", "Uncertain historical work remains blocked", "--effect-paths-fenced", "--post-snapshot-work-reviewed"];
    await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(/same inputs and --request-id/); await program.parseAsync(args, { from: "user" });
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(requests[0]).not.toHaveProperty("actor");
  } finally { vi.unstubAllGlobals(); log.mockRestore(); error.mockRestore(); if (oldSecret === undefined) delete process.env.BARRY_SECRET; else process.env.BARRY_SECRET = oldSecret; }
});
it("binds an explicit new CLI invocation to the recovery epoch without rewriting an old key", async () => {
  const epoch = "fae7af55-ad99-4a5f-8bf7-4fe2b2b05439", fetch = vi.spyOn(globalThis, "fetch");
  await expect(startOperatorWork("echo", { inputJson: "{}", recoveryEpoch: epoch, key: "unconfirmed-old-key", delegationKeys: "/must-not-read" })).rejects.toThrow(/new key prefixed/); expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore();
  const { installationRegistry } = await import("@barry-rocks/sdk/internal/nodes"), { WorkDelegationVerifier } = await import("@barry-rocks/sdk/internal/workflows");
  const installation = installationRegistry().id, key = { id: "recovery", secret: "fixture-only-dedicated-recovery-operator-key", not_before: 0, not_after: Date.now() + 3600000 }, keys = join(process.env.BARRY_HOME!, "recovery-cli-keys.json");
  writeFileSync(keys, JSON.stringify({ "workflows.cli.operator": [key] }), { mode: 0o600 }); const oldSecret = process.env.BARRY_SECRET; process.env.BARRY_SECRET = "recovery-fixture-secret";
  const verifier = new WorkDelegationVerifier({ installation, keys: () => [key], authorizeIssuer: record => record.issuer === "workflows.cli.operator" && record.source_kind === "operator" && record.authority.namespace.principal_kind === "operator", currentPolicy: async record => record.authority.caller_ceiling }); let request: { idempotency_key: string; recovery_epoch: string } | undefined;
  vi.stubGlobal("fetch", async (input: unknown, init: RequestInit) => {
    if (String(input).endsWith("/api/metadata")) return Response.json({ installation, recovery: { epoch, active: true } });
    const body = JSON.parse(String(init.body)); await verifier.authenticate(body.request, body.delegation, "admit"); request = body.request;
    await expect(verifier.authenticate({ ...body.request, recovery_epoch: "c7e6eb20-d9cf-4d76-8b5c-6b54a88931c0" }, body.delegation, "admit")).rejects.toThrow();
    return Response.json({ work: { work_id: "fresh-work", workflow_id: "fresh-workflow", facts: { coordinator: "running", phase: "queued", wait: "none", physical: "not-started", effect: "not-started", stop_requested: false, has_result: false, can_continue: false, can_retry_step: false, can_respond: false } } });
  });
  try { const accepted = await startOperatorWork("echo", { inputJson: "{}", recoveryEpoch: epoch, delegationKeys: keys }, () => {}); expect(request?.recovery_epoch).toBe(epoch); expect(accepted.idempotency_key.startsWith(`${epoch}:`)).toBe(true); }
  finally { vi.unstubAllGlobals(); if (oldSecret === undefined) delete process.env.BARRY_SECRET; else process.env.BARRY_SECRET = oldSecret; }
});
