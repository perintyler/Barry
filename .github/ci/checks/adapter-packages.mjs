import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "barry-adapter-packages-"));
const entries = JSON.parse(readFileSync(join(root, "workspace-entries.json"), "utf8"));
const shipped = Object.entries(entries).filter(([path, spec]) => spec.mode === "compiled" && /^adapters\/(completions|decisions|embeddings|sessions)\//.test(path));
// `node adapter-packages.mjs adapters/sessions/claude @barry-rocks/…` checks only
// those providers; no arguments checks every one. Each provider is an npm
// install from the registry, so a run over all of them is long, and CI can
// split it.
const only = process.argv.slice(2);
const providers = only.length ? shipped.filter(([path, spec]) => only.includes(path) || only.includes(spec.name)) : shipped;
const unknown = only.filter(name => !shipped.some(([path, spec]) => path === name || spec.name === name));
if (unknown.length) throw new Error(`Not a shipped provider: ${unknown.join(", ")}. Shipped: ${shipped.map(([path]) => path).join(", ")}`);
/** Bound every registry install and adapter probe; see docs/decisions/0015-verification-and-socket-invariants.md. */
const COMMAND_TIMEOUT_MS = Number(process.env.ADAPTER_PACKAGES_COMMAND_TIMEOUT_MS ?? 240_000);
const tarballs = new Map();
const manifests = new Map();
function run(command, args, cwd = root) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" });
  } catch (error) {
    if (error?.signal === "SIGKILL") throw new Error(`${command} ${args.join(" ")} did not finish within ${COMMAND_TIMEOUT_MS / 1000}s (in ${cwd})`);
    throw error;
  }
}
function pack(path) {
  const manifest = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
  run("pnpm", ["--dir", join(root, path), "pack", "--pack-destination", scratch]);
  const tarball = join(scratch, `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`);
  const contents = run("tar", ["-tzf", tarball]).trim().split("\n");
  assert.equal(contents.filter(file => file === "package/LICENSE.md").length, 1);
  assert.equal(run("tar", ["-xOzf", tarball, "package/LICENSE.md"]), readFileSync(join(root, "LICENSE.md"), "utf8"));
  const packed = JSON.parse(run("tar", ["-xOzf", tarball, "package/package.json"]));
  assert.ok(!JSON.stringify(packed).includes("workspace:"));
  for (const entry of Object.values(packed.exports)) {
    for (const target of typeof entry === "string" ? [entry] : [entry.types, entry.import]) {
      assert.ok(contents.includes(`package/${target.slice(2)}`), `Missing ${manifest.name} export ${target}`);
    }
  }
  if (path !== "sdk") {
    assert.ok(contents.includes("package/LICENSE.md"));
    assert.ok(contents.every(file => !/(?:\/src\/|\.test\.|\/node_modules\/)/.test(file)));
  }
  tarballs.set(manifest.name, tarball);
  manifests.set(manifest.name, packed);
}
try {
  pack("sdk");
  for (const [path] of providers) pack(path);
  for (const [path, { name }] of providers) {
    const consumer = join(scratch, name.split("/")[1]);
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "adapter-consumer", private: true, type: "module" }));
    const selected = new Set(["@barry-rocks/sdk"]);
    function select(packageName) {
      if (selected.has(packageName)) return;
      selected.add(packageName);
      for (const dependency of Object.keys(manifests.get(packageName).dependencies ?? {})) {
        if (tarballs.has(dependency)) select(dependency);
      }
    }
    select(name);
    run("npm", ["install", "--no-audit", "--no-fund", ...[...selected].map(packageName => tarballs.get(packageName)), "typescript@5.9.3", "@types/node@22.15.0"], consumer);
    const installed = readdirSync(join(consumer, "node_modules/@barry-rocks")).map(part => `@barry-rocks/${part}`);
    assert.deepEqual(installed.sort(), [...selected].sort(), "Installing one provider brought unrelated providers");
    const vendor = path.split("/").at(-1);
    const kind = path.includes("/sessions/") ? "session" : path.includes("/completions/") ? "completion" : path.includes("/embeddings/") ? "embedding" : "decision";
    const factories = { "embedding-ollama": "ollamaEmbeddingModel", "completion-anthropic": "messagesCompletionModel", "completion-ollama": "ollamaCompletionModel", "completion-llamacpp": "llamacppCompletionModel", "decision-anthropic": "messagesDecisionModel", "decision-ollama": "ollamaDecisionModel", "decision-typesafe": "jevDecisionModel", "decision-von": "vonDecisionModel" };
    writeFileSync(join(consumer, "probe.mjs"), `
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mutable = require('node:child_process');
for (const operation of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) mutable[operation] = () => { throw Error('Eager process launch'); };
syncBuiltinESMExports();
let contacts = 0;
globalThis.fetch = async () => { contacts++; throw Error('Eager authentication/network request'); };
const module = await import(${JSON.stringify(name)});
const endpoint = {baseUrl:'https://fixture.invalid', apiKey:'explicit-fixture-key'};
${kind === "session" ? `const adapter = module.default;
assert.equal(typeof adapter.id, 'string');
assert.ok(adapter.modes[adapter.defaultMode]);
const { loadAdapters } = await import('@barry-rocks/sdk/internal/adapters');
const sessionStore = loadAdapters({file:${JSON.stringify(join(consumer, "session-adapters.json"))}});
assert.deepEqual(sessionStore.installed(), []);
await sessionStore.add(${JSON.stringify(join(consumer, "node_modules", name))});
assert.equal(sessionStore.installed()[0].packageName, ${JSON.stringify(name)});
assert.equal(sessionStore.installed()[0].contractVersion, 1);
assert.equal((await sessionStore.load(adapter.id)).id, adapter.id);
assert.equal(sessionStore.remove(adapter.id), true);
assert.deepEqual(sessionStore.installed(), []);` : `const model = ${vendor === "systemone" ? "module.systemoneDecisionModel({vendorId:'fixture', model:'fixture-model', endpoint, label:'Fixture', credentialEnv:'FIXTURE_API_KEY', keyRequired:true})" : `module.${factories[name.split("/")[1]]}('fixture-model', endpoint)`};
assert.equal(model.ref, ${JSON.stringify(`${vendor === "systemone" ? "fixture" : vendor}/fixture-model`)});
assert.equal(typeof model.${kind === "completion" ? "complete" : kind === "embedding" ? "embed" : "decide"}, 'function');`}
${kind !== "session" && vendor !== "systemone" ? `
const { loadModelVendors } = await import('@barry-rocks/sdk/adapters/models');
const store = loadModelVendors({file:${JSON.stringify(join(consumer, "model-vendors.json"))}});
assert.deepEqual(store.installed(), []);
await store.add(${JSON.stringify(join(consumer, "node_modules", name))});
assert.equal(store.installed()[0].packageName, ${JSON.stringify(name)});
const selectedFactories = await store.load();
assert.equal(typeof selectedFactories.${kind}[${JSON.stringify(vendor)}], 'function');
assert.equal(store.remove(${JSON.stringify(name)}), true);
assert.deepEqual(store.installed(), []);
` : ""}
assert.equal(contacts, 0);
`);
    run(process.execPath, ["probe.mjs"], consumer);
    const invocation = kind === "session" ? "module.default" : vendor === "systemone"
      ? "module.systemoneDecisionModel({vendorId:'fixture', model:'fixture-model', endpoint, label:'Fixture', credentialEnv:'FIXTURE_API_KEY', keyRequired:true})"
      : `module.${factories[name.split("/")[1]]}('fixture-model', endpoint)`;
    writeFileSync(join(consumer, "consumer.ts"), `
import * as module from ${JSON.stringify(name)};
const endpoint = {baseUrl:'https://fixture.invalid', apiKey:'explicit-fixture-key'};
const model = ${invocation};
const ref: string = model.${kind === "session" ? "id" : "ref"};
void ref;
`);
    run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2023", "consumer.ts"], consumer);
    console.log(`Independent provider verified: ${name} (${selected.size} Barry packages)`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
