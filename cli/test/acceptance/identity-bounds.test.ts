import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { bindSecretReferences } from "@barry-rocks/sdk/internal/identities";
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { nodeTsArgv, openInstance } from "@barry-rocks/sdk/internal/services";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Barry } from "@barry-rocks/sdk";
import { identities, owner } from "@barry-rocks/identities-bag";
import { sessions } from "@barry-rocks/sessions-bag";
import { identitiesSqlite } from "@barry-rocks/identities-bag/testing";
import { renameIdentityRow, seedIdentityRow } from "../helpers/identities.js";
import { fixtureSession } from "../fixtures/harness.js";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { barryAdaptersPath, barryAppSupportDir, listenOnAssignedPort } from "@barry-rocks/sdk/services";
import { pathToFileURL } from "node:url";

import { defaultBags, loadBuiltinRegistry, loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import { upsertBag } from "../../src/bags/registration.js";
import { applyAuth, applyBaseMiddleware } from "@barry-rocks/sdk/services/http";

import { installShim } from "../../src/lib/identity-shims.js";
import { boundsFixture as fixture } from "../fixtures/identity-bounds.js";

vi.hoisted(() => { process.env.BARRY_SECRET = "acceptance-fixture-secret"; });

// Only the model boundary is replaced; registries, stores, commands and transports are real.
vi.mock("@barry-rocks/sdk/adapters/models", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/adapters/models")>(),
  createModels: () => ({ vendors: () => [], embedding: () => ({ embed: async () => ({ embeddings: [[0]] }) }) }),
}));
const run = promisify(execFile);
/** A resource's text; a blob has none. */
const textOf = (content: { text: string } | { blob: string }) => ("text" in content ? content.text : "");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; vi.unstubAllEnvs(); });

it("preserves identity bags and bounds through a generated CLI, HTTP-created session and real MCP calls", async () => {
  // The MCP application and the session routes run in this process, as their
  // own entry points host them: with the identities and sessions subjects installed.
  Barry.use(identities, sessions);
  cleanup.push(async () => Barry.reset());
  vi.stubEnv("BARRY_CONFIG_ALLOW_EMPTY", "1");
  vi.stubEnv("BARRY_SECRET", "acceptance-fixture-secret");
  const home = process.env.BARRY_HOME!;
  writeFileSync(join(home, "app-support", "env"), "BARRY_SECRET=acceptance-fixture-secret\n", { mode: 0o600 });
  const bag = join(home, "fixture-bag");
  const effects = join(home, "effects.jsonl");
  const capture = join(home, "harness.jsonl");
  const adapterPath = join(home, "harness"); mkdirSync(adapterPath);
  writeFileSync(join(adapterPath, "package.json"), JSON.stringify({ name: "acceptance", version: "1.0.0", type: "module", exports: { ".": { import: "./adapter.mjs" } }, barry: { sessionAdapter: { contractVersion: 1 } } }));
  writeFileSync(join(adapterPath, "adapter.mjs"), `export { fixtureAdapter as default } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../fixtures/harness.ts")).href)};`);
  writeFileSync(join(adapterPath, "bag.yaml"), "name: acceptance-harness\ndescription: Deterministic fixture\ncredentials:\n  ACCEPTANCE_KEY:\n    source: vault\n    item: fixture\n    field: password\n");
  const adapters = loadAdapters({ file: barryAdaptersPath() });
  const adapterRecord = await adapters.add(adapterPath);
  mkdirSync(bag, { recursive: true });
  mkdirSync(join(bag, "instructions"));
  writeFileSync(join(bag, "instructions", "guidance.md"), `---\nname: acceptance-guidance\nmode: always\n---\n${fixture.guidance}\n`);
  writeFileSync(effects, "");
  mkdirSync(join(bag, "migrations"));
  writeFileSync(join(bag, "migrations", "001_initial.sql"), "CREATE TABLE documents(id TEXT PRIMARY KEY);");
  writeFileSync(join(bag, "bag.yaml"), `name: ${fixture.bag}\ndescription: Disposable bounds fixture\nstore:\n  owned_by: identity\n  engine: sqlite\n  migrations: ./migrations\nbags:\n  - ${fixture.ungrantedBag}\n`);
  const ungranted = join(home, "ungranted-bag"); mkdirSync(ungranted);
  writeFileSync(join(ungranted, "bag.yaml"), `name: ${fixture.ungrantedBag}\ndescription: Packed with denied tools\n`);
  for (const [path, tools] of [[bag, fixture.tools.filter(tool => tool.namespace !== "unselected")], [ungranted, fixture.tools.filter(tool => tool.namespace === "unselected")]] as const) {
    const sdk = join(import.meta.dirname, "../../../sdk");
    mkdirSync(join(path, "node_modules", "@barry-rocks"), { recursive: true });
    symlinkSync(sdk, join(path, "node_modules", "@barry-rocks", "sdk"), "dir");
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: path === bag ? fixture.bag : fixture.ungrantedBag, version: "1.0.0", type: "module", dependencies: { "@barry-rocks/sdk": `file:${sdk}` } }));
    const definitions = path === bag ? [...tools, { name: "read_hidden", namespace: fixture.tools[0].namespace, access: "read" }] : tools;
    writeFileSync(join(path, "tools.ts"), `
      import { appendFileSync } from 'node:fs';
      import { Barry } from '@barry-rocks/sdk';
      export function registerMcpResources(server, context) {
        const uri = ${JSON.stringify(`acceptance://${path === bag ? fixture.bag : fixture.ungrantedBag}/info`)};
        server.registerResource('fixture-info', uri, { mimeType: 'application/json' }, async () => ({
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ secrets: context.secrets }) }]
        }));
      }
      export const tools = ${JSON.stringify(definitions)}.map(tool => Barry.Tool({ ...tool, description: tool.name, schema: {}, secrets: tool.name === 'read_document' ? ['ACCEPTANCE_TOOL_ONLY'] : [],
        handler: async (_params, context) => { const store = tool.name === 'read_document' ? Barry.bag(${JSON.stringify(fixture.bag)}).store() : undefined; appendFileSync(${JSON.stringify(effects)}, JSON.stringify({tool: tool.name, store, secrets: context.secrets, bagNames: context.bagNames})+'\\n'); return {tool:tool.name}; }
      }));
    `);
  }
  const builtins = loadBuiltinRegistry();
  if (builtins.models) await upsertBag("models", builtins.models);
  await upsertBag(fixture.bag, { type: "local", path: bag });
  await upsertBag(fixture.ungrantedBag, { type: "local", path: ungranted });
  const user = await owner.users.create({ name: "acceptance", email: "acceptance@example.test" });
  owner.installation().bind({ actorId: user.id, actorToken: user.token });
  const configuredStore = join(home, "configured-artifacts.db");
  writeFileSync(join(home, ".env"), "ACCEPTANCE_KEY=declared-fixture-key\nACCEPTANCE_TOOL_ONLY=must-stay-tool-scoped\n");
  // Rows with no directory: the generated CLI and the sessions bind to a row id
  // and only read it, and the test edits the row in place below.
  const identity = seedIdentityRow({
    actorId: user.id,
    name: "bonanza",
    metadata: {
      bag_configs: {
        [fixture.bag]: {
          stores: { default: { filepath: configuredStore } },
          tools: { read_hidden: "disabled" },
        },
      },
      tool_discovery: "provider",
      secrets: bindSecretReferences(
        { ACCEPTANCE_KEY: { in: ".env" }, ACCEPTANCE_TOOL_ONLY: { in: ".env" } },
        home,
      ),
      adapters: { acceptance: { default: true } },
      bound: { tools: { deny: ["close_issue"] } },
      bags: [fixture.bag],
      bounds: [...fixture.bounds],
    },
  });
  const bin = join(home, "bin"); mkdirSync(bin);
  const command = `barry-acceptance-${process.pid}`;
  expect(installShim(command, identity.name, { binDir: bin, barryPath: "unused", binding: {
    id: identity.id, home, instance: openInstance(barryAppSupportDir()).id,
  } }).status).toBe("installed");
  renameIdentityRow(identity.id, "renamed");
  const foreignHome = join(home, "second-instance");
  openInstance(join(foreignHome, "app-support"));
  const mismatchedCommand = `${command}-wrong-instance`;
  expect(installShim(mismatchedCommand, identity.name, { binDir: bin, barryPath: "unused", binding: {
    id: identity.id, home: foreignHome, instance: openInstance(barryAppSupportDir()).id,
  } }).status).toBe("installed");
  await expect(run(join(bin, mismatchedCommand), ["run", fixture.bag, "read-document", "--json"], {
    env: process.env, timeout: 30000,
  })).rejects.toThrow(/identity CLI belongs to another instance/);
  const cli = async (tool: string) => run(join(bin, command), ["run", tool === "read_unselected" ? fixture.ungrantedBag : fixture.bag, tool.replaceAll("_", "-"), "--json"], {
    env: { ...process.env, BARRY_IDENTITY: "foreign", TSX_DISABLE_CACHE: "1" }, timeout: 30000,
  });
  await expect(cli("read_hidden")).rejects.toThrow();
  expect((await cli("read_document")).stdout).toContain("read_document");
  for (const tool of fixture.denied) await expect(cli(tool)).rejects.toThrow(/tool access denied/);

  const { startMcpApplication } = await import("../../../bags/mcp/src/application.js");
  const portReservation = await listenOnAssignedPort(express(), { PORT: "0" });
  const port = (portReservation.address() as { port: number }).port;
  await new Promise<void>(resolve => portReservation.close(() => resolve()));
  const application = await startMcpApplication({ port, snapshot: await loadBagRegistrySnapshot() });
  cleanup.push(() => application.close());
  expect((await run(join(bin, command), ["session", "run", "--prompt", "fixture", "--cwd", home], {
    env: { ...process.env, ACCEPTANCE_UNDECLARED: "must-not-leak", TSX_DISABLE_CACHE: "1" }, timeout: 30000,
  })).stdout).toContain("fixture completed");
  const { setAgentRuntime } = await import("../../../bags/sessions/api/src/agent-runtime.js");
  setAgentRuntime({ createSession: async (_harness, config) => fixtureSession(config),
    runStructured: async () => { throw new Error("unused fixture boundary"); }, describeAdapter: () => adapterRecord });
  const { sessionLifecycleRouter } = await import("../../../bags/sessions/api/src/routes/session-lifecycle.js");
  const app = express(); applyBaseMiddleware(app); applyAuth(app); app.use("/sessions", sessionLifecycleRouter);
  const http = await listenOnAssignedPort(app, { PORT: "0" });
  cleanup.push(() => new Promise<void>(resolve => { http.closeAllConnections(); http.close(() => resolve()); }));
  const address = http.address() as { port: number };
  const created = await fetch(`http://127.0.0.1:${address.port}/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer acceptance-fixture-secret" },
    body: JSON.stringify({ repoPath: home, systemPrompt: "Acceptance fixture", identityId: identity.id, bags: [], provider: "acceptance", prompt: "fixture", name: "HTTP bounds fixture" }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const body = await created.json();
  const sessionId = body.id;
  expect(body.started, JSON.stringify(body)).toBe(true);
  await expect.poll(() => readFileSync(capture, "utf8").trim().split("\n").length).toBe(2);
  const captured = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const config of captured) {
    expect(config.env.ACCEPTANCE_KEY).toBe("declared-fixture-key");
    expect(config.env.ACCEPTANCE_UNDECLARED).toBeUndefined();
    expect(config.env.ACCEPTANCE_TOOL_ONLY).toBeUndefined();
    expect(config.deniedTools).toContain("ForbiddenNative");
    expect(config.decision.allow).toBe(false);
    expect(config.systemPrompt).toContain(fixture.guidance);
  }
  const { sessionRuntime } = await import("../../../bags/sessions/api/src/session-runtime.js");
  cleanup.push(() => sessionRuntime.stopSession(sessionId));
  expect((await fetch(`http://127.0.0.1:${address.port}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  for (const boundedSession of captured) {
    const { getSession } = await import("@barry-rocks/sessions-bag/client");
    const stored = await getSession(boundedSession.sessionId);
    expect(stored, JSON.stringify(boundedSession)).toBeDefined();
    expect(stored?.identity_id).toBe(identity.id);
    const client = new Client({ name: "acceptance", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?sessionId=${boundedSession.sessionId}`), {
      requestInit: { headers: { Authorization: "Bearer acceptance-fixture-secret" } },
    }));
    cleanup.push(() => client.close());
    const listed = await client.listTools();
    expect((await client.listResources()).resources.filter(resource => resource.uri.startsWith("acceptance://")).map(resource => resource.uri)).toEqual([`acceptance://${fixture.bag}/info`]);
    const resource = await client.readResource({ uri: `acceptance://${fixture.bag}/info` });
    expect(JSON.parse(textOf(resource.contents[0])).secrets).toEqual({ ACCEPTANCE_TOOL_ONLY: "must-stay-tool-scoped" });
    await expect(client.readResource({ uri: `acceptance://${fixture.ungrantedBag}/info` })).rejects.toThrow();
    expect(listed.tools.map(tool => tool.name)).not.toContain("read_hidden");
    expect((await client.callTool({ name: "read_hidden", arguments: {} })).isError).toBe(true);
    expect(listed.tools.map(tool => tool.name).filter(name => fixture.tools.some(tool => tool.name === name)), JSON.stringify({ stored, listed })).toEqual([...fixture.allowed]);
    expect((await client.callTool({ name: "read_document", arguments: {} })).isError).not.toBe(true);
    for (const name of fixture.denied) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
    }
  }
  const stdioClient = new Client({ name: "stdio-bounds-fixture", version: "1" });
  const [stdioCommand, ...stdioArgs] = nodeTsArgv(join(import.meta.dirname, "../../../bags/mcp/src/server-main.ts"));
  const stdioEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

  delete stdioEnv.BARRY_SECRET;
  stdioEnv.ACCEPTANCE_TOOL_ONLY = "unrelated-ambient-tool-key";
  stdioEnv.ACCEPTANCE_UNDECLARED = "unrelated-ambient-key";
  const stdioTransport = new StdioClientTransport({ command: stdioCommand, args: [...stdioArgs, "--stdio", "--identity-id", String(identity.id), "--harness", "acceptance"], env: stdioEnv, stderr: "pipe" });
  let diagnostics = "";
  stdioTransport.stderr?.on("data", chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
  cleanup.push(() => stdioClient.close());
  try {
    await stdioClient.connect(stdioTransport);
    const tools = await stdioClient.listTools();
    expect((await stdioClient.listResources()).resources.filter(resource => resource.uri.startsWith("acceptance://")).map(resource => resource.uri)).toEqual([`acceptance://${fixture.bag}/info`]);
    const resource = await stdioClient.readResource({ uri: `acceptance://${fixture.bag}/info` });
    expect(JSON.parse(textOf(resource.contents[0])).secrets).toEqual({ ACCEPTANCE_TOOL_ONLY: "must-stay-tool-scoped" });
    await expect(stdioClient.readResource({ uri: `acceptance://${fixture.ungrantedBag}/info` })).rejects.toThrow();

    expect(tools.tools.map(tool => tool.name).filter(name => fixture.tools.some(tool => tool.name === name))).toEqual([...fixture.allowed]);
    expect(tools.tools.some(tool => tool.name === "read_hidden")).toBe(false);
    expect((await stdioClient.callTool({ name: "read_document", arguments: {} })).isError).not.toBe(true);
    for (const name of fixture.denied) expect((await stdioClient.callTool({ name, arguments: {} })).isError).toBe(true);
  } catch (error) {
    throw new Error(`stdio acceptance failed: ${diagnostics}`, { cause: error });
  } finally {
    await stdioClient.close();
  }
  expect(readFileSync(effects, "utf8").trim().split("\n").map(line => JSON.parse(line).tool)).toEqual(Array(4).fill("read_document"));
  const effectsByInvocation = readFileSync(effects, "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const effect of effectsByInvocation) expect(effect.secrets).toEqual({ ACCEPTANCE_TOOL_ONLY: "must-stay-tool-scoped" });
  expect(effectsByInvocation.at(-1).bagNames).toEqual([fixture.bag, fixture.ungrantedBag]);
  const registry = new NodeRegistry();
  const ownershipId = registry.identityId(identity.id);
  registry.close();
  for (const line of readFileSync(effects, "utf8").trim().split("\n")) {
    const binding = JSON.parse(line).store;
    expect(binding).toMatchObject({ identity: ownershipId, bag: fixture.bag, store: "default", engine: "sqlite", owned_by: "identity" });
    expect(binding.filepath).toBe(configuredStore);
  }

  const { Sessions } = await import("@barry-rocks/sessions-bag/client");
  const other = seedIdentityRow({ actorId: user.id, name: "other", metadata: { bags: [], bounds: [] } });
  const { ActionRuns } = await import("@barry-rocks/actions-bag");
  const foreignRun = await ActionRuns.create({ action: "acceptance:read", bag: null, metadata: { identity_id: other.id } });
  await expect(run(join(bin, command), ["action", "show", foreignRun.id, "--json"], {
    env: process.env, timeout: 30000,
  })).rejects.toThrow(/action run does not belong to this identity/);
  const { createAtSchedule, getAtSchedule } = await import("@barry-rocks/schedules-bag");
  const { schedule: foreignSchedule } = createAtSchedule({ bag: fixture.bag, action: "acceptance:read", dueAt: new Date(Date.now() + 86400000), permissions: { identity: other.name } });
  await expect(run(join(bin, command), ["schedule", "cancel", foreignSchedule.id], {
    env: process.env, timeout: 30000,
  })).rejects.toThrow(/schedule does not belong to this identity/);
  expect(getAtSchedule(foreignSchedule.id)?.status).toBe("pending");
  const foreignSession = await Sessions.createInert({ identity_id: other.id, bags: [], bounds: [], metadata: { working_directory: home } });
  await expect(run(join(bin, command), ["session", "resume", foreignSession.id, "--none"], {
    env: process.env, timeout: 30000,
  })).rejects.toThrow(/session belongs to another identity/);
  expect(readFileSync(capture, "utf8").trim().split("\n")).toHaveLength(2);

  // A row-only identity's bounds, changed in place: the operations change only
  // an identity with a directory.
  const setRowBounds = (entries: readonly unknown[]) =>
    identitiesSqlite().prepare("UPDATE identities SET metadata = json_set(metadata, '$.bounds', json(?)) WHERE id = ?").run(JSON.stringify(entries), identity.id);
  for (const invalid of fixture.malformed) {
    setRowBounds([...fixture.bounds, invalid.entry]);
    await expect(cli("read_document")).rejects.toThrow(new RegExp(invalid.error));
    const refused = await fetch(`http://127.0.0.1:${address.port}/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer acceptance-fixture-secret" },
      body: JSON.stringify({ repoPath: home, systemPrompt: "Fixture", identityId: identity.id, bags: [], provider: "acceptance", prompt: "fixture" }),
    });
    expect(refused.status).toBe(201);
    const refusedBody = await refused.json();
    expect(refusedBody.started).toBe(false);
    expect(refusedBody.startError).toMatch(new RegExp(invalid.error));
    const failedClient = new Client({ name: "refused-fixture", version: "1" });
    await failedClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?sessionId=${refusedBody.id}`), {
      requestInit: { headers: { Authorization: "Bearer acceptance-fixture-secret" } },
    }));
    cleanup.push(() => failedClient.close());
    expect((await failedClient.listTools()).tools.some(tool => fixture.tools.some(expected => expected.name === tool.name))).toBe(false);
  }
  expect(readFileSync(capture, "utf8").trim().split("\n")).toHaveLength(2);
  expect(readFileSync(effects, "utf8").trim().split("\n")).toHaveLength(4);
  setRowBounds([...fixture.bounds]);
  await sessionRuntime.stopSession(sessionId);
  const { closeSessionsDb } = await import("@barry-rocks/sessions-bag/store/sessions-db");
  closeSessionsDb();
  const { sessionBound } = await import("../../../bags/mcp/src/session-bound.js");
  for (const boundedSession of captured) {
    const restored = await Sessions.get(boundedSession.sessionId);
    expect(restored?.identity_id).toBe(identity.id);
    expect(restored?.bags).toEqual(boundedSession === captured[0] ? [...defaultBags(), fixture.bag] : []);
    expect(restored?.bounds).toEqual(boundedSession === captured[0] ? [...fixture.selectedBounds] : []);
    const reopened = await sessionBound(boundedSession.sessionId, fixture.tools.map(tool => ({ namespace: tool.namespace, toolName: tool.name, access: tool.access })));
    expect([...reopened.allowedTools]).toEqual([...fixture.allowed]);
    expect(reopened.bound).toMatchObject({
      tools: {
        deny: expect.arrayContaining(["*:write", "unselected:*", "close_issue", "acceptance:ForbiddenNative"]),
      },
    });
  }
}, 120000);
