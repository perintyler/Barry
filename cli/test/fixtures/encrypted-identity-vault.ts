import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import { VaultClient } from "@barry-rocks/sdk/internal/vault";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const self = fileURLToPath(import.meta.url);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const commandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("seed"), item: z.string(), preserve: z.boolean() }).strict(),
  z.object({ command: z.literal("resolve"), ids: z.array(z.number().int()), concurrent: z.boolean() }).strict(),
]);
export interface EncryptedResolution { id: number; keys?: string[]; digest?: string; error?: string }

/** Real store setup/resolution runs in a child with only the disposable installation bound. */
async function fixtureCommand(input: z.infer<typeof commandSchema>): Promise<void> {
  const home = realpathSync(process.env.BARRY_HOME ?? ""), root = dirname(home);
  assert.equal(process.env.VITEST, "true");
  assert.equal(basename(home), "home");
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.match(basename(root), /^(encrypted-identity-vault|installed-identity-work)-[A-Za-z0-9]+$/);
  const { bootstrapStoreGeneration } = await import("@barry-rocks/sdk/internal/stores");
  const { barryStoresDir } = await import("@barry-rocks/sdk/services");
  const { identitiesSqlite } = await import("@barry-rocks/identities-bag/testing");
  const { identities, identityRecords, owner } = await import("@barry-rocks/identities-bag");
  const { Barry } = await import("@barry-rocks/sdk");
  const { identityEnvironmentForId, setIdentityStore } = await import("@barry-rocks/sdk/internal/env");
  if (input.command === "seed") {
    bootstrapStoreGeneration(barryStoresDir());
    const db = identitiesSqlite();
    if (!input.preserve) {
      db.prepare("INSERT INTO actors(id,token,type,name) VALUES(1,'encrypted-owner','user','Encrypted owner')").run();
      owner.installation().bind({ actorId: 1, actorToken: "encrypted-owner" });
    }
    const existing = db.prepare("SELECT metadata FROM identities WHERE id=42").get() as { metadata: string } | undefined;
    const metadata = (vault: string, original: Record<string, unknown> = {}) => ({ ...original, vault,
      secrets: { SCRIPT_KEY: { reference: { in: "vault" as const, item: input.item, field: "password" as const }, directory: home } } });
    if (existing) db.prepare("UPDATE identities SET metadata=? WHERE id=42").run(JSON.stringify(metadata("encrypted-a", JSON.parse(existing.metadata))));
    else db.prepare("INSERT INTO identities(id,token,actor_id,name,metadata) VALUES(42,'encrypted-a',1,'encryptedidentity',?)").run(JSON.stringify(metadata("encrypted-a")));
    db.prepare("INSERT INTO actors(id,token,type,name) VALUES(2,'encrypted-other-owner','user','Encrypted other owner')").run();
    db.prepare("INSERT INTO identities(id,token,actor_id,name,metadata) VALUES(43,'encrypted-b',2,'encryptedidentity',?)").run(JSON.stringify(metadata("encrypted-b")));
    const { mergeInheritedIdentity } = await import("@barry-rocks/sdk/internal/identities");
    const parent = metadata("encrypted-a");
    const insertChild = db.prepare("INSERT INTO identities(id,token,actor_id,name,metadata) VALUES(?,?,1,?,?)");
    insertChild.run(44, "encrypted-vaultless-child", "vaultlesschild", JSON.stringify(mergeInheritedIdentity(parent, {})));
    insertChild.run(45, "encrypted-own-vault-child", "ownvaultchild", JSON.stringify(mergeInheritedIdentity(parent, { vault: "encrypted-b" })));
  } else {
    Barry.use(identities);
    setIdentityStore({ get: identityRecords.row, resolveConfig: identityRecords.config, touchLastUsed: identityRecords.touch });
    const resolve = async (id: number): Promise<EncryptedResolution> => {
      try {
        const environment = await identityEnvironmentForId(id, { names: ["SCRIPT_KEY"], touch: false });
        return { id, keys: Object.keys(environment.vars).filter(name => name !== "BARRY_STATUS_NOTIFY"), digest: digest(environment.vars.SCRIPT_KEY) };
      } catch (error) { return { id, error: error instanceof Error ? error.message : String(error) }; }
    };
    const results: EncryptedResolution[] = [];
    if (input.concurrent) results.push(...await Promise.all(input.ids.map(resolve)));
    else for (const id of input.ids) results.push(await resolve(id));
    process.stdout.write(JSON.stringify(results));
  }
}

export async function encryptedIdentityVault(options: { home?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "encrypted-identity-vault-")), home = options.home ?? join(root, "home");
  // macOS Unix sockets have a short pathname limit; own this separate short directory too.
  const socketDirectory = mkdtempSync("/tmp/ev-"), socket = join(socketDirectory, "v.sock"), url = `unix://${socket}`;
  const data = join(root, "data"), dbPath = join(data, "vault.db"), privateDirectory = join(data, "private");
  for (const directory of [home, join(home, "config"), join(home, "app-support"), privateDirectory]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const registrationSecret = randomUUID();
  writeFileSync(join(privateDirectory, "barry.yaml"), JSON.stringify({ secrets: { VAULT_REGISTRATION_SECRET: { in: ".env" } } }), { mode: 0o600 });
  writeFileSync(join(privateDirectory, ".env"), `VAULT_REGISTRATION_SECRET=${registrationSecret}\n`, { mode: 0o600 });
  if (!options.home) writeFileSync(join(home, "config", "barry.yaml"), "{\"secrets\":{}}", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: tmpdir(), BARRY_HOME: home, BARRY_DIR: repo, BARRY_BUILTIN_DIR: join(repo, "bags"), LC_ALL: "C", SCRIPT_KEY: "wrong-ambient-vault-value" };
  let stdout = "", stderr = "", done = false;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = Promise.resolve({ code: null, signal: null });
  const launchDaemon = () => {
    done = false;
    const processChild = spawn(process.execPath, ["--import", "tsx", join(repo, "bags/vault/server/src/index.ts")], { cwd: join(repo, "cli"), env: { ...env, DATA_DIR: data, VAULT_DB_PATH: dbPath, VAULT_SOCKET_PATH: socket }, stdio: ["ignore", "pipe", "pipe"] });
    processChild.stdout.on("data", bytes => { stdout = (stdout + String(bytes)).slice(-120000); });
    processChild.stderr.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-120000); });
    closed = new Promise(resolve => processChild.once("close", (code, signal) => { done = true; resolve({ code, signal }); }));
    return processChild;
  };
  let child = launchDaemon();
  const request = (path: string, auth?: string, method = "GET", body?: unknown) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ socketPath: socket, path, method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), "Content-Type": "application/json" }, timeout: 1000 }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk)));res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });req.on("error", reject);req.on("timeout", () => req.destroy(new Error("Fixture socket request timed out")));if (body !== undefined) req.write(JSON.stringify(body));req.end();
  });
  const setup = async (command: z.infer<typeof commandSchema>) => {
    const processChild = spawn(process.execPath, ["--import", "tsx", self, JSON.stringify(command)], { cwd: join(repo, "cli"), env: { ...env, VITEST: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";processChild.stdout.on("data", bytes => { output += String(bytes); });processChild.stderr.on("data", bytes => { error += String(bytes); });
    const exit = await new Promise<number | null>(resolve => processChild.once("close", resolve));assert.equal(exit, 0, error);return output;
  };
  const stopDaemon = async () => {
    if (!done) child.kill("SIGTERM");
    const deadline = Date.now() + 10000;while (!done && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (!done) { child.kill("SIGKILL");await closed;throw new Error(`Vault shutdown exceeded10s; retained ${root}: ${stderr}`); }
    assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
    assert.equal(existsSync(socket), false, "Vault must remove its owned socket on graceful shutdown");
  };
  const close = async () => {
    await stopDaemon();
    rmSync(root, { recursive: true, force: true });rmSync(socketDirectory, { recursive: true, force: true });
  };
  const waitReady = async () => {
    const deadline = Date.now() + 20000;let ready = false;
    while (Date.now() < deadline) {
      if (done) throw new Error(`Vault exited before readiness: ${stderr}`);
      try { if ((await request("/health")).status === 200) { ready = true;break; } } catch { /* Socket may not exist until bind. */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(ready, true, `Vault readiness failed: ${stderr}`);
  };
  try {
    await waitReady();
    const client = new VaultClient(url, { registrationSecret });
    const canaries = { a: "encrypted-account-a-secret-" + randomUUID(), b: "encrypted-account-b-secret-" + randomUUID() }, item = "same-secret-name-" + randomUUID();
    const emailA = `a-${randomUUID()}@fixture.invalid`, emailB = `b-${randomUUID()}@fixture.invalid`;
    const a = await client.register(emailA), b = await client.register(emailB);
    const authA = await client.loginWithApiKey(a.clientId, a.clientSecret, a.masterPassword, emailA), authB = await client.loginWithApiKey(b.clientId, b.clientSecret, b.masterPassword, emailB);
    const itemA = await client.createItem(authA, { name: item, password: canaries.a }), itemB = await client.createItem(authB, { name: item, password: canaries.b });
    const envPath = join(home, "app-support", "env"), original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "SCRIPT_KEY=wrong-installation-vault-value\n";
    const accounts: Record<string, unknown> = {}, values: Record<string, string> = {};
    for (const [name, credentials, email] of [["encrypted-a", a, emailA], ["encrypted-b", b, emailB]] as const) {
      const prefix = name.toUpperCase().replaceAll("-", "_");
      const mapping = { client_id: credentials.clientId, client_secret: credentials.clientSecret, master_password: credentials.masterPassword, email };
      accounts[name] = { server_url: url, bootstrap: Object.fromEntries(Object.entries(mapping).map(([field, value]) => { const key = prefix + "_" + field.toUpperCase();values[key] = value;return [field, { in: ".env", key }]; })) };
    }
    const writeBootstrap = (overrides: Record<string, string | null> = {}) => writeFileSync(envPath, original + Object.entries({ ...values, ...overrides }).filter(([, value]) => value !== null).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
    writeBootstrap();
    writeFileSync(join(home, "config", "vault-accounts.yaml"), JSON.stringify({ version: 1, accounts }), { mode: 0o600 });
    await setup({ command: "seed", item, preserve: Boolean(options.home) });
    const read = <T>(operation: (db: Database.Database) => T) => { const db = new Database(dbPath, { readonly: true });try { return operation(db); } finally { db.close(); } };
    return { home, root, url, item, canaries, client, authA, authB, itemA, itemB, expectedA: digest(canaries.a), expectedB: digest(canaries.b),
      resolve: async (ids: number[], concurrent = false) => JSON.parse(await setup({ command: "resolve", ids, concurrent })) as EncryptedResolution[],
      crossAccount: (method: string) => request(`/api/items/${itemA}`, authB.token, method, method === "PUT" ? { password: "must-not-write" } : undefined),
      encryptedRows: () => read(db => db.prepare("SELECT account_id,name,password FROM items ORDER BY account_id").all()) as { account_id: string; name: string; password: string }[],
      revokedCount: () => read(db => Number((db.prepare("SELECT count(*) AS n FROM revoked_tokens").get() as { n: number }).n)),
      persistentBytes: () => Buffer.concat([dbPath, dbPath + "-wal"].filter(existsSync).map(path => readFileSync(path))),
      setBootstrapA: (field: "email" | "master_password", value: string | null) => writeBootstrap({ ["ENCRYPTED_A_" + field.toUpperCase()]: value }),
      resetBootstrap: () => writeBootstrap(),
      restart: async () => { await stopDaemon();child = launchDaemon();await waitReady(); },
      rotateA: async (value: string) => { await client.updateItem(authA, itemA, { password: value });return digest(value); },
      pendingActivities: (workflowId: string) => {
        const paths = readdirSync(home, { recursive: true }).map(String).filter(path => path.endsWith("/workflows.db"));
        assert.equal(paths.length, 1);
        const db = new Database(join(home, paths[0]!), { readonly: true });
        try { return db.prepare("SELECT id FROM workflow_commands WHERE run_id=? AND state='pending' AND attempts=0 AND json_extract(definition,'$.kind')='activity'").all(workflowId); }
        finally { db.close(); }
      },
      deleteA: () => client.deleteItem(authA, itemA), diagnostics: () => ({ pid: child.pid, done, stdout, stderr }), close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], `Encrypted vault setup/cleanup failed; retained ${root}`); }
    throw error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  await fixtureCommand(commandSchema.parse(JSON.parse(process.argv[2] ?? "null")));
  process.exit(0);
}
