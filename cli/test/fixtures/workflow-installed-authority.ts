/** Real installed registration, identity/session bounds and declared credentials.
 * The caller is a trusted in-process installation principal, not an HTTP or
 * common-Work admission fixture. No acceptance configure callback exists. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Barry } from "@barry-rocks/sdk";
import { collectToolDefinitions } from "@barry-rocks/sdk/internal/tools";
import { createModels, installModels, installedModels } from "@barry-rocks/sdk/adapters/models";
import type { AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import { installationRegistry, closeInstallationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { bootstrapStoreGeneration, withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { barryStoresDir } from "@barry-rocks/sdk/services";
import { identities, owner } from "@barry-rocks/identities-bag";
import { identitiesSqlite, closeIdentitiesStore } from "@barry-rocks/identities-bag/testing";
import { sessions } from "@barry-rocks/sessions-bag";
import { getSessionsSqlite, closeSessionsDb } from "@barry-rocks/sessions-bag/store/sessions-db";
import { InstalledWorkflowSessions } from "../../../bags/sessions/api/src/workflow-installed-sessions.js";
import { installedPiRuntimeRegistration } from "./workflow-runtime-registration.js";

export async function workflowInstalledAuthority() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-installed-authority-"))), home = join(root, "home"), secretDirectory = join(root, "selected-secrets");
  for (const path of [home, secretDirectory, join(home, "config"), join(home, "app-support")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const names = ["BARRY_HOME", "BARRY_BAGS_SNAPSHOT", "BARRY_IDENTITIES_DB", "BARRY_SESSIONS_DB", "BARRY_CONFIG_DB", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let previousModels: ReturnType<typeof installedModels> | undefined;try { previousModels = installedModels(); } catch { /* no prior installation */ }
  closeSessionsDb();closeIdentitiesStore();closeInstallationRegistry();Barry.reset();
  process.env.BARRY_HOME = home;
  for (const name of ["BARRY_IDENTITIES_DB", "BARRY_SESSIONS_DB", "BARRY_CONFIG_DB"]) delete process.env[name];
  process.env.OPENAI_API_KEY = "host-ambient-openai-must-not-run";process.env.ANTHROPIC_API_KEY = "host-ambient-anthropic-must-not-run";
  writeFileSync(join(home, "config/barry.yaml"), JSON.stringify({ secrets: {} }), { mode: 0o600 });
  const snapshot = join(home, "app-support/bags.snapshot.json");process.env.BARRY_BAGS_SNAPSHOT = snapshot;
  writeFileSync(snapshot, JSON.stringify({ bags: { pi: { type: "local", path: realpathSync(fileURLToPath(new URL("../../../adapters/sessions/pi/", import.meta.url))) } } }), { mode: 0o600 });
  let selectedKey = "selected-private-provider-" + randomUUID();
  const result = "actual installed identity authority result";
  const writeSecrets = (present: boolean, replacement?: string) => { if (replacement !== undefined) selectedKey = replacement;return writeFileSync(join(secretDirectory, ".env"), present ? `OPENAI_API_KEY=${selectedKey}\nANTHROPIC_API_KEY=selected-harness-only\nUNRELATED_SECRET=must-not-leak\n` : "", { mode: 0o600 }); };
  writeSecrets(true);bootstrapStoreGeneration(barryStoresDir());
  const db = identitiesSqlite();
  db.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'installed-owner','user','Installed owner'),(2,'foreign-owner','user','Foreign owner')").run();
  const metadata = { bags: [], secrets: Object.fromEntries(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].map(name => [name, { reference: { in: ".env" }, directory: secretDirectory }])) };
  db.prepare("INSERT INTO identities(id,token,actor_id,name,metadata) VALUES(42,'installed-identity',1,'installed',?),(43,'foreign-identity',2,'foreign',?)").run(JSON.stringify(metadata), JSON.stringify({ bags: [], secrets: {} }));
  owner.installation().bind({ actorId: 1, actorToken: "installed-owner" });Barry.use(identities, sessions);
  const registry = installationRegistry(), identity = registry.identityId(42), foreignIdentity = registry.identityId(43);
  // A legitimate nonempty installed registry whose actual Pi bag has no Barry
  // tools. An empty bags table is a corrupt snapshot, not a tool-free bound.
  const toolDefinitions = await collectToolDefinitions();
  let sessionDb = withStoreContext({ identity }, getSessionsSqlite);
  const insert = sessionDb.prepare("INSERT INTO sessions(id,user_id,identity_id,bags,metadata) VALUES(?,?,?,'[]',?)");
  insert.run("owned", 1, 42, JSON.stringify({ provider: "pi" }));insert.run("nested", 1, 42, JSON.stringify({ provider: "pi", source: "action-executor" }));
  insert.run("ended", 1, 42, JSON.stringify({ provider: "pi" }));sessionDb.prepare("UPDATE sessions SET state='closed',ended_at=datetime('now') WHERE id='ended'").run();
  withStoreContext({ identity: foreignIdentity }, () => getSessionsSqlite().prepare("INSERT INTO sessions(id,user_id,identity_id,bags,metadata) VALUES('foreign',2,43,'[]','{}')").run());
  let unexpectedTool = false, heldProvider = false;
  let providerRequested!: () => void;
  const providerRequest = new Promise<void>(resolve => { providerRequested = resolve; });
  const effectPath = join(root, "unexpected-native-effect.txt");
  const requests: { authorization: string | undefined; body: unknown; phase: string; handle: unknown }[] = [], providerErrors: string[] = [];
  const provider = createServer((req, res) => {
    let raw = "";req.on("data", bytes => { raw += String(bytes); });req.on("end", () => {
      try {
        assert.equal(req.headers.authorization, `Bearer ${selectedKey}`);
        const fence = sessionDb.prepare("SELECT phase,handle_json FROM session_workflow_settlements ORDER BY rowid DESC LIMIT 1").get() as { phase: string; handle_json: string };
        assert.equal(fence.phase, "input");assert.ok(JSON.parse(fence.handle_json).pid);
        const body = JSON.parse(raw);requests.push({ authorization: req.headers.authorization, body, phase: fence.phase, handle: JSON.parse(fence.handle_json) });providerRequested();
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "installed-authority", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (heldProvider) { chunk({ role: "assistant" }, null);return; }
        if (unexpectedTool) {
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: "unexpected-native-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: effectPath, content: "must-not-execute" }) } }] }, null);chunk({}, "tool_calls");
        } else { chunk({ role: "assistant", content: result }, null);chunk({}, "stop"); }
        res.end("data: [DONE]\n\n");
      } catch (error) { providerErrors.push(String(error));res.writeHead(500);res.end(); }
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
  const models = () => createModels([{ id: "openai", label: "Actual local OpenAI protocol", baseUrl: endpoint, credential: { env: "OPENAI_API_KEY" }, models: [{ id: "probe", label: "Local probe", kind: "completion" }] }]);installModels(models());
  let installed: Awaited<ReturnType<typeof installedPiRuntimeRegistration>> | undefined;let manager: InstalledWorkflowSessions | undefined;
  try {
    installed = await installedPiRuntimeRegistration();
    const registrationFixture = installed, installation = await registrationFixture.start();
    const make = () => new InstalledWorkflowSessions({ installation, directory: join(root, "destinations") });manager = make();
    const principal = { kind: "installation", actorId: 1, credentialId: "installation" } as const;
    const request = (key = "authority/" + randomUUID(), overrides: Partial<Parameters<InstalledWorkflowSessions["prepare"]>[0]> = {}) => ({ key, callerSessionId: "owned", principal, identity, harness: "pi", model: "openai/probe", bags: [], cwd: root, maxTurns: 1, deadline: Date.now() + 60000, ...overrides });
    return { root, identity, foreignIdentity, principal, result, requests, providerErrors, request, writeSecrets, toolDefinitions,
      get selectedKey() { return selectedKey; },
      get sessionDb() { return sessionDb; },
      get manager() { return manager!; },
      unexpectedToolResponse() { unexpectedTool = true; },
      holdProvider() { heldProvider = true; },
      async waitForProviderRequest() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([providerRequest, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Actual provider request was not observed")), 20000); })]); }
        finally { clearTimeout(timer); }
      },
      hasUnexpectedEffect() { return existsSync(effectPath); },
      async reopen() { await manager!.close();closeSessionsDb();sessionDb = withStoreContext({ identity }, getSessionsSqlite);manager = make(); },
      emptyModels() { installModels(createModels([])); },
      endOrigin() { sessionDb.prepare("UPDATE sessions SET state='closed',ended_at=datetime('now') WHERE id='owned'").run(); },
      changeAuthority(kind: "bags" | "bound" | "actor" | "identity" | "identity-deletion") {
        const origin = sessionDb.prepare("SELECT bags,bound,user_id,identity_id,metadata FROM sessions WHERE id='owned'").get() as { bags: string; bound: string | null; user_id: number; identity_id: number; metadata: string };
        const identityRow = db.prepare("SELECT * FROM identities WHERE id=42").get() as Record<string, unknown>;
        if (kind === "bags") sessionDb.prepare("UPDATE sessions SET bags=? WHERE id='owned'").run(JSON.stringify(["changed-session-bag"]));
        if (kind === "bound") sessionDb.prepare("UPDATE sessions SET bound=? WHERE id='owned'").run(JSON.stringify({ tools: { deny: ["pi:write"] } }));
        if (kind === "actor") sessionDb.prepare("UPDATE sessions SET user_id=2 WHERE id='owned'").run();
        if (kind === "identity") sessionDb.prepare("UPDATE sessions SET identity_id=43 WHERE id='owned'").run();
        if (kind === "identity-deletion") db.prepare("DELETE FROM identities WHERE id=42").run();
        return () => {
          if (kind === "identity-deletion") {
            const columns = Object.keys(identityRow);db.prepare("INSERT INTO identities(" + columns.join(",") + ") VALUES(" + columns.map(() => "?").join(",") + ")").run(...Object.values(identityRow));
          }
          sessionDb.prepare("UPDATE sessions SET bags=?,bound=?,user_id=?,identity_id=?,metadata=? WHERE id='owned'").run(origin.bags, origin.bound, origin.user_id, origin.identity_id, origin.metadata);
        };
      },
      declarations() { return sessionDb.prepare("SELECT authority_json FROM session_workflow_execution_authorities").all() as { authority_json: string }[]; },
      async close(preserve = false) {
        const errors: unknown[] = [];
        try { if (preserve) { await sessionDb.backup(join(root, "failure-sessions.db"));writeFileSync(join(root, "failure-observations.json"), JSON.stringify({ requests, providerErrors }, null, 2), { mode: 0o600 }); } }
        catch (error) { errors.push(error); }
        try { await manager!.close(); } catch (error) { errors.push(error); }
        provider.closeAllConnections();await new Promise<void>(resolve => provider.close(() => resolve()));
        try { await registrationFixture.close(preserve || errors.length > 0); } catch (error) { errors.push(error); }
        closeSessionsDb();closeIdentitiesStore();closeInstallationRegistry();Barry.reset();
        for (const name of names) { if (previous[name] === undefined) delete process.env[name];else process.env[name] = previous[name]; }
        if (previousModels) installModels(previousModels);else Reflect.deleteProperty(globalThis, Symbol.for("barry.models.v1"));
        if (!preserve && !errors.length) rmSync(root, { recursive: true, force: true });
        if (errors.length) throw new AggregateError(errors, "Installed authority cleanup failed; preserved " + root);
      },
    };
  } catch (error) {
    try { await manager?.close(); } catch { /* preserve primary setup failure */ }
    provider.closeAllConnections();await new Promise<void>(resolve => provider.close(() => resolve()));
    try { await installed?.close(true); } catch { /* retain registration cleanup uncertainty with primary failure */ }closeSessionsDb();closeIdentitiesStore();closeInstallationRegistry();Barry.reset();
    for (const name of names) { if (previous[name] === undefined) delete process.env[name];else process.env[name] = previous[name]; }
    if (previousModels) installModels(previousModels);else Reflect.deleteProperty(globalThis, Symbol.for("barry.models.v1"));
    throw new Error("Installed authority setup failed; preserved " + root, { cause: error });
  }
}

export const foreignInstallationPrincipal: AuthPrincipal = { kind: "installation", actorId: 2, credentialId: "installation" };
