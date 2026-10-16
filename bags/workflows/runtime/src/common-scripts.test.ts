import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sessionToken } from "@barry-rocks/sdk/auth";
import { SqliteDatabase } from "@barry-rocks/sdk/internal/stores";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { WorkArtifactStore, retainedScriptArchive, retainedScriptActivities } from "@barry-rocks/sdk/internal/workflows";

it.each([false, true])("installed scripts retain queued code across owner death/catalog replacement and refresh original Bash authority (external=%s)", async external => {
  const began = performance.now();
  const phase = (name: string) => console.info("installed script fixture phase", JSON.stringify({ external, name, elapsed_ms: Math.round(performance.now() - began) }));
  const root = mkdtempSync(join(tmpdir(), "installed-scripts-")), home = join(root, "home"), bag = join(root, "scripts"), action = join(bag, "actions", "fixture");
  mkdirSync(action, { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true }); mkdirSync(join(home, "app-support"), { recursive: true });
  writeFileSync(join(home, "config", "barry.yaml"), JSON.stringify({ secrets: { SCRIPT_KEY: { in: ".env" } } }));
  const selectedEnv = join(home, "app-support", "env"); writeFileSync(selectedEnv, "SCRIPT_KEY=fixture-selected-script-value\n", { mode: 0o600 });
  const snapshot = join(root, "bags.json"), keys = join(root, "keys.json"), manifest = join(root, "script-resources.json"), secret = "installed-script-fixture";
  writeFileSync(join(bag, "bag.yaml"), JSON.stringify({ name: "fixturescripts", description: "Disposable script work" }));
  writeFileSync(join(action, "action.yaml"), JSON.stringify({ name: "fixture", description: "Return a retained script result", context: "none", run: "main.sh", timeout: 15,
    preflight: { command: "test -n \"$SCRIPT_KEY\" && test \"$SCRIPT_KEY\" != wrong-ambient || exit 7; printf probe >> probe-effects; printf '%s\\n' \"$BARRY_JOB_KEY\" >> stage-keys; exit 1", hint: "advisory probe fixture", timeout: 2 },
    validate: { files_exist: ["effects"], command: "test -n \"$SCRIPT_KEY\" && test \"$SCRIPT_KEY\" != wrong-ambient || exit 7; printf post >> post-effects; printf '%s\\n' \"$BARRY_JOB_KEY\" >> stage-keys; exit 1", timeout: 2 },
    env: ["DECLARED=explicit"], secrets: ["SCRIPT_KEY"], input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, output_schema: { type: "object" } }));
  const projectionConfig = join(root, "action-projections.json"), projectionPath = join(root, "history", "actions.db");
  writeFileSync(projectionConfig, JSON.stringify({ version: 1, routes: [{ owner: { kind: "operator" }, path: projectionPath }] }));
  const source = (generation: string) => ['test -z "$BARRY_SECRET" || exit 3', 'test "$DECLARED" = explicit || exit 4', 'test -n "$SCRIPT_KEY" && test "$SCRIPT_KEY" != wrong-ambient || exit 6', 'test "$(cat)" = "$BARRY_ACTION_INPUTS" || exit 5', 'printf once >> effects', 'printf fixture-script-log >&2',
    `printf '{"generation":"${generation}","asset":"%s","id":"%s"}' "$(cat "$BARRY_ACTION_DIR/asset.txt")" "$BARRY_ACTION_RUN_ID"`].join("\n");
  writeFileSync(join(action, "main.sh"), source("original")); writeFileSync(join(action, "asset.txt"), "original-asset");
  writeFileSync(snapshot, JSON.stringify({ bags: {
    workflows: { type: "local", path: fileURLToPath(new URL("../../", import.meta.url)) }, fixturescripts: { type: "local", path: bag },
    bash: { type: "local", path: fileURLToPath(new URL("../../../bash", import.meta.url)) },
  } }));
  writeFileSync(manifest, JSON.stringify({ version: 1, scripts: [{ reference: "fixturescripts:fixture", resource_policy: "closed", allowed_roots: [action], entry: "main.sh",
    files: ["main.sh", "asset.txt", "action.yaml"].map(path => ({ path, source: join(action, path) })), arguments: [{ index: 0, path: "main.sh", format: "path" }] }] }));
  writeFileSync(keys, JSON.stringify({ "workflows.runtime.operator": [{ id: "operator", secret: "disposable-installed-script-signing-key", not_before: Date.now() - 1000, not_after: Date.now() + 3600000 }],
    "workflows.cli.operator": [{ id: "cli", secret: "disposable-installed-script-cli-key", not_before: Date.now() - 1000, not_after: Date.now() + 3600000 }] }), { mode: 0o600 });
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve)); const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`, env: NodeJS.ProcessEnv = { PATH: process.env.PATH, BARRY_HOME: home, BARRY_SECRET: secret, SCRIPT_KEY: "wrong-ambient", BARRY_BAGS_SNAPSHOT: snapshot, BARRY_WORKFLOW_DELEGATION_KEYS: keys,
    BARRY_WORKFLOW_ACTION_PROJECTIONS: projectionConfig, BARRY_WORKFLOW_SCRIPT_RESOURCES: manifest, BARRY_WORKFLOW_SCRIPT_TRAITS: '["bash","script-launch"]', PORT: String(port) };
  const children: { child: ReturnType<typeof spawn>; closed: Promise<void> }[] = [];
  const launch = (args: string[], cwd?: string) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }); let output = "", error = "";
    child.stdout!.on("data", data => { output += String(data); }); child.stderr!.on("data", data => { error = (error + String(data)).slice(-12000); });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve())); children.push({ child, closed }); return { child, closed, output: () => output, error: () => error };
  };
  const setBashAccess = async (access: "read" | "readwrite") => {
    writeFileSync(join(home, "config", "identity.yaml"), JSON.stringify({
      bounds: { "script-launch": access === "read" ? { description: "Deny write", tools: { deny: ["*:write"] } } : { description: "Allow script launch" } },
    }));
  };
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  const call = (path: string) => fetch(url + path, { headers });
  const start = (key: string, inputs: unknown = { value: "fixture-input" }) => fetch(url + "/api/v2/work/start", { method: "POST", headers: { Cookie: `barry_session=${sessionToken(secret)}`, Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({ version: 2, request_id: randomUUID(), idempotency_key: key, definition: { kind: "action", reference: "fixturescripts:fixture", catalog_namespace: "fixturescripts" }, inputs }) });
  const ready = async () => {
    const owner = launch(["--import", "tsx", fileURLToPath(new URL("./service.ts", import.meta.url))]);
    await expect.poll(() => owner.output() + owner.error(), { timeout: 15000 }).toContain("runtime ready"); return owner;
  };
  try {
    await setBashAccess("readwrite"); const owner = await ready(); phase("initial owner ready");
    const metadata = await (await call("/api/metadata")).json();
    let expectedWorker = `${metadata.installation}:common`;
    expect(metadata.work.definitions).toContainEqual(expect.objectContaining({ kind: "action", reference: "fixturescripts:fixture", catalog_namespace: "fixturescripts" }));
    const refused = await start("invalid", { misspelled: true }); expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: "InvalidInputs", admission_disposition: "not-accepted" });
    const database = join(home, readdirSync(home, { recursive: true }).map(String).find(path => path.endsWith("/workflows.db"))!);
    const fault = new SqliteDatabase(database); try { fault.exec("CREATE TRIGGER hold_script_claim BEFORE INSERT ON workflow_attempts BEGIN SELECT RAISE(ABORT,'fixture holds script'); END"); } finally { fault.close(); }
    const response = await start("retained-original"); expect(response.status, await response.clone().text()).toBe(201); const accepted = (await response.json()).work;
    owner.child.kill("SIGKILL"); await owner.closed;
    const repair = new SqliteDatabase(database); try { repair.exec("DROP TRIGGER hold_script_claim"); } finally { repair.close(); }
    writeFileSync(join(action, "main.sh"), source("replacement")); writeFileSync(join(action, "asset.txt"), "replacement-asset");
    let hostConfig: string | undefined;
    if (external) {
      const artifactRoot = join(dirname(database), "work-artifacts"), store = new WorkArtifactStore(artifactRoot);
      const peersPath = readdirSync(home, { recursive: true }).map(String).find(path => path.endsWith("/peers.db"))!;
      const peers = new NodeRegistry(dirname(join(home, peersPath))), credential = join(root, "host-credential");
      const prepare = launch(["--import", "tsx", "--input-type=module", "--eval", `import{installationScripts,WorkArtifactStore}from'@barry-rocks/sdk/internal/workflows';const store=new WorkArtifactStore(${JSON.stringify(artifactRoot)});const scripts=await installationScripts(${JSON.stringify(manifest)},store,${JSON.stringify(metadata.installation)});process.stdout.write(JSON.stringify(scripts.map(script=>({type:script.type,source:store.path(script.source),digest:script.source.digest,kind:'program'}))));store.close();process.exit(0);`], fileURLToPath(new URL("../", import.meta.url)));
      await prepare.closed; expect(prepare.child.exitCode, prepare.error()).toBe(0);
      const activities = [...JSON.parse(prepare.output()), { type: accepted.plan.process_program.activity_type, source: store.path(accepted.plan.source_closure.find((ref: { digest: string }) => ref.digest === accepted.plan.process_program.source_digest)), digest: accepted.plan.process_program.source_digest, kind: "program" }];
      const invited = peers.inviteWorker("script-host", activities.map(activity => activity.type)); peers.close(); store.close();
      expectedWorker = invited.worker.id;
      writeFileSync(credential, invited.credential, { mode: 0o600 });
      const mapping = join(root, "hosts.json"); writeFileSync(mapping, JSON.stringify({ version: 1, mode: "external", worker_ids: [invited.worker.id] })); env.BARRY_WORKFLOW_COMMON_HOSTS = mapping;
      hostConfig = join(root, "host.json"); writeFileSync(hostConfig, JSON.stringify({ version: 1, installation: metadata.installation, directory: join(root, "separate-host"), artifact_root: artifactRoot,
        owners: [{ id: metadata.installation, url, credential_file: credential }], activities, capacity: 1 }));
    }
    const currentOwner = await ready(); phase("replacement owner ready");
    if (hostConfig) {
      const host = launch([fileURLToPath(new URL("../../../../sdk/dist/workflows/work-process-host-cli.js", import.meta.url)), "--config", hostConfig]);
      await expect.poll(host.output, { timeout: 10000 }).toContain("process-work-host-ready");
    }
    await expect.poll(async () => (await (await call(`/api/v2/work/${accepted.work_id}`)).json()).state, { timeout: 15000 }).toBe("completed");
    const projected = (id: string) => {
      const db = new SqliteDatabase(projectionPath);
      try { return db.prepare("SELECT a.*,p.result FROM action_runs a JOIN action_work_projections p ON p.action_id=a.id WHERE p.work_id=?").get(id); }
      finally { db.close(); }
    };
    await expect.poll(() => projected(accepted.work_id)?.status, { timeout: 10000 }).toBe("failed");
    expect(JSON.parse(String(projected(accepted.work_id)?.output))).toMatchObject({ generation: "original", id: accepted.action_id });
    expect(JSON.parse(String(projected(accepted.work_id)?.result)).logs.some((log: { value: { stderr: string } | null }) => log.value?.stderr.includes("fixture-script-log"))).toBe(true);
    const result = await (await call(`/api/v2/work/${accepted.work_id}/result`)).json();
    expect(result.outcome).toEqual({ ok: true, value: { generation: "original", asset: "original-asset", id: accepted.action_id } });
    expect(result.action_checks).toMatchObject({ preflight: { passed: false, unknown: false }, postcondition: { passed: false, unknown: false } });
    phase("retained original result verified");
    const replay = await start("retained-original"); expect(replay.status).toBe(200); expect((await replay.json()).work.work_id).toBe(accepted.work_id);
    mkdirSync(join(home, "app-support"), { recursive: true });
    writeFileSync(join(home, "app-support", "bag-resources.json"), JSON.stringify({ version: 2, generated: new Date().toISOString(), resources: { "workflows.runtime": { bag: "workflows", name: "runtime", kind: "service", url } } }));
    const cli = launch(["--import", "tsx", "--input-type=module", "--eval", `import{startOperatorWork}from${JSON.stringify(fileURLToPath(new URL("../../../../cli/src/commands/work.ts", import.meta.url)))};process.stdout.write(JSON.stringify(await startOperatorWork('fixturescripts:fixture',{kind:'action',traits:'bash,script-launch',key:'new-catalog',inputJson:'{"value":"cli-input"}'})));process.exit(0);`], fileURLToPath(new URL("../../../../cli", import.meta.url)));
    await cli.closed; expect(cli.child.exitCode, cli.error()).toBe(0); expect(cli.error()).toContain("Submission key: new-catalog"); const replacement = JSON.parse(cli.output());
    await expect.poll(async () => (await (await call(`/api/v2/work/${replacement.work_id}`)).json()).state, { timeout: 15000 }).toBe("completed");
    expect((await (await call(`/api/v2/work/${replacement.work_id}/result`)).json()).outcome.value.generation).toBe("replacement");
    phase("replacement result verified");
    expect(readFileSync(join(action, "effects"), "utf8")).toBe("onceonce");
    expect(readFileSync(join(action, "probe-effects"), "utf8")).toBe("probeprobe");
    expect(readFileSync(join(action, "post-effects"), "utf8")).toBe("postpost");
    expect(new Set(readFileSync(join(action, "stage-keys"), "utf8").trim().split("\n")).size).toBe(4);
    const retained = new SqliteDatabase(database);
    try {
      expect(retained.prepare("SELECT DISTINCT worker FROM workflow_attempts").all()).toEqual([{ worker: expectedWorker }]);
      expect(JSON.stringify(retained.prepare("SELECT record FROM workflow_work_admissions").all())).not.toContain("fixture-selected-script-value");
      expect(JSON.stringify(retained.prepare("SELECT request FROM workflow_work_executions").all())).not.toContain("fixture-selected-script-value");
    } finally { retained.close(); }
    const archiveStore = new WorkArtifactStore(join(dirname(database), "work-artifacts"));
    try {
      expect(retainedScriptActivities(database, archiveStore)).toEqual({});
      const inventory = retainedScriptArchive(database, archiveStore); expect(inventory).toHaveLength(2);
      expect(inventory.every(artifact => artifact.kind === "program" && artifact.bytes! > 0)).toBe(true);
    } finally { archiveStore.close(); }
    writeFileSync(selectedEnv, ""); const missing = await start("missing-selected-secret"); expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "WorkCredentialsUnavailable", admission_disposition: "not-accepted" });
    await setBashAccess("read"); expect((await start("revoked-bash")).status).toBe(409);
    await expect.poll(() => projected(replacement.work_id)?.status, { timeout: 10000 }).toBe("failed");
    // Target loss is metadata repair, even after source/credentials/authority changed.
    phase("stopping owner before target loss"); currentOwner.child.kill("SIGTERM"); await currentOwner.closed; phase("owner stopped before target loss");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(projectionPath + suffix, { force: true });
    await ready();
    await expect.poll(() => projected(accepted.work_id)?.status, { timeout: 10000 }).toBe("failed");
    await expect.poll(() => projected(replacement.work_id)?.status, { timeout: 10000 }).toBe("failed");
    const history = new SqliteDatabase(projectionPath);
    try { expect(history.prepare("SELECT count(*) n FROM action_runs").get()?.n).toBe(2); }
    finally { history.close(); }
    // An accepted key replays before credential resolution, even though its
    // selected credential remains absent and new Bash authority was revoked.
    const prior = await start("retained-original"); expect(prior.status).toBe(200); expect((await prior.json()).work.work_id).toBe(accepted.work_id);
    expect(readFileSync(join(action, "effects"), "utf8")).toBe("onceonce");
  } finally {
    phase("fixture cleanup");
    for (const process of children) if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGTERM");
    await Promise.all(children.map(process => process.closed)); rmSync(root, { recursive: true, force: true });
  }
}, 60000);
