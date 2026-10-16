import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { importWorkAgentCatalog, readWorkAgentConfiguration, workAgentProfileSchema, type WorkAgentCatalog, type WorkAgentProfile } from "./work-agent-profile.js";
import { WorkArtifactStore, type WorkArtifactRef } from "./work-artifacts.js";
import { OwnerWorkAdmission } from "./work-admission.js";
import { WorkflowStore } from "./workflow-store.js";

/** Store-level custody only: these minimal manifests are not native executable
 * closures, and no identity admission, provider request or process is simulated. */
const roots: string[] = [], stores: WorkArtifactStore[] = [], databases: WorkflowStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sourceMetadata = { owner_identity: null, purpose: "source" as const, media_type: "application/octet-stream" };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "work-agent-profile-")));
  roots.push(root);
  const from = new WorkArtifactStore(join(root, "producer")), into = new WorkArtifactStore(join(root, "owner"));
  stores.push(from, into);
  const chunks = [from.stage(Buffer.from("first captured chunk"), sourceMetadata), from.stage(Buffer.from("second captured chunk"), sourceMetadata)];
  const manifest = { version: 2, protocol: 1, harness: "pi", chunks: chunks.map(({ digest, bytes }) => ({ digest, bytes })),
    files: [0, 1, 0, 1].map(index => ({ storage: { chunk: chunks[index]!.digest } })) };
  const stageManifest = (value = manifest) => from.stage(Buffer.from(JSON.stringify(value)), sourceMetadata);
  const runtime = stageManifest();
  const profile: WorkAgentProfile = { version: 1, installation: "installation", reference: "fixture:agent", title: "Custody fixture", harness: "pi", model: "fixture/model",
    endpoint: "http://127.0.0.1:12345/v1", generation: randomUUID(), record_hash: "a".repeat(64),
    runtime: { version: 1, protocol: 1, digest: runtime.digest, bytes: runtime.bytes }, provider: {}, cwd: { path: root, device: 1, inode: 1 },
    validation: { mode: "none" }, prompt: "One tool-free turn", max_turns: 1, execution_budget_ms: 1000,
    budget_policy: "reservation-only", endpoint_resource: "fixture-endpoint", max_input_tokens: 100, max_output_tokens: 4096, max_cost: 0,
    sources: [runtime, ...chunks] };
  const stageProfile = (value: WorkAgentProfile = profile) => from.stage(Buffer.from(JSON.stringify(value)), sourceMetadata);
  const catalog: WorkAgentCatalog = { version: 1, installation: "installation", worker_id: randomUUID(), artifact_root: from.root,
    endpoint_broker: { id: "shared-endpoint", path: join(root, "endpoint.db"), limits: { "fixture-endpoint": { kind: "endpoint", concurrency: 1, input_tokens: 1000, output_tokens: 8192, cost_micros: 1000 } } },
    profiles: [stageProfile()] };
  const importing = (value: WorkAgentProfile = profile) => importWorkAgentCatalog({ ...catalog, profiles: [stageProfile(value)] }, from, into);
  return { root, from, into, chunks, manifest, runtime, profile, catalog, stageManifest, stageProfile, importing };
}

it("copies and pins the complete runtime root, chunks and definition through actual aged staging collection and store reopen", () => {
  const f = fixture(), installed = f.importing();
  expect(installed).toHaveLength(1);
  const references = installed[0]!.sources;
  expect(new Set(references.map(item => item.digest))).toEqual(new Set([...f.profile.sources, f.catalog.profiles[0]!].map(item => item.digest)));
  const bytes = references.map(reference => f.from.verify(reference));
  const old = new Date(Date.now() - 3 * 86_400_000);
  for (const reference of references) utimesSync(f.into.path(reference), old, old);
  const orphan = f.into.stage(Buffer.from("unaccepted aged staging"), sourceMetadata);
  utimesSync(f.into.path(orphan), old, old);
  const db = new WorkflowStore(":memory:", "installation"); databases.push(db);
  const gc = new OwnerWorkAdmission({ id: "installation", store: db, artifacts: f.into, now: () => Date.now(), verifiedEvaluator: () => false,
    artifact: () => undefined, retainWorkflow: () => { throw new Error("GC must not retain a workflow"); },
    prepareStart: () => { throw new Error("GC must not start a workflow"); }, reserve: () => { throw new Error("GC must not reserve capacity"); } });
  expect(gc.collectStaging()).toBe(1);
  expect(existsSync(f.into.path(orphan))).toBe(false);
  // Remove the producer: the imported catalog must not depend on its staging.
  f.from.close(); rmSync(f.from.root, { recursive: true });
  f.into.close();
  const reopened = new WorkArtifactStore(f.into.root); stores.push(reopened);
  references.forEach((reference, index) => expect(reopened.verify(reference).equals(bytes[index]!)).toBe(true));
});

it.each(["omitted", "mismatched-bytes", "duplicate", "wrong-media"] as const)("refuses %s runtime chunk custody", kind => {
  const f = fixture(), profile = structuredClone(f.profile);
  if (kind === "omitted") profile.sources.pop();
  if (kind === "mismatched-bytes") profile.sources[1]!.bytes++;
  if (kind === "duplicate") profile.sources.push({ ...profile.sources[1]! });
  if (kind === "wrong-media") profile.sources[1]!.media_type = "application/json";
  expect(() => f.importing(profile)).toThrow();
});

it.each(["unknown-file-chunk", "duplicate-chunk", "wrong-harness", "legacy-manifest"] as const)("refuses a verified manifest with %s", kind => {
  const f = fixture(), manifest = structuredClone(f.manifest);
  if (kind === "unknown-file-chunk") manifest.files[0]!.storage.chunk = "f".repeat(64);
  if (kind === "duplicate-chunk") manifest.chunks.push({ ...manifest.chunks[0]! });
  if (kind === "wrong-harness") manifest.harness = "other";
  const runtime = kind === "legacy-manifest" ? f.from.stage(Buffer.from(JSON.stringify({ ...manifest, version: 1 })), sourceMetadata) : f.stageManifest(manifest);
  const profile = { ...f.profile, runtime: { ...f.profile.runtime, digest: runtime.digest, bytes: runtime.bytes }, sources: [runtime, ...f.chunks] };
  expect(() => f.importing(profile)).toThrow();
});

it.each(["runtime", "chunk", "definition"] as const)("refuses %s content corruption before returning an installed catalog", target => {
  const f = fixture();
  const reference: WorkArtifactRef = target === "runtime" ? f.runtime : target === "chunk" ? f.chunks[0]! : f.catalog.profiles[0]!;
  writeFileSync(f.from.path(reference), Buffer.alloc(reference.bytes, 0x78));
  expect(() => importWorkAgentCatalog(f.catalog, f.from, f.into)).toThrow(/digest/);
});

it("refuses foreign installation, absent endpoint resources and a substituted artifact root", () => {
  const f = fixture();
  expect(() => f.importing({ ...f.profile, installation: "foreign" })).toThrow(/InstallationMismatch/);
  expect(() => f.importing({ ...f.profile, budget_policy: "reservation-only", endpoint_resource: "unknown" })).toThrow(/InstallationMismatch/);
  expect(() => importWorkAgentCatalog({ ...f.catalog, artifact_root: f.into.root }, f.from, f.into)).toThrow(/ArtifactRootMismatch/);
  expect(() => importWorkAgentCatalog({ ...f.catalog, endpoint_broker: { ...f.catalog.endpoint_broker, limits: { "fixture-endpoint": { kind: "host", agents: { unscheduled: 1, scheduled: 1, per_caller: 1 }, processes: { unscheduled: 1, scheduled: 1 }, guarded: 1 } } } }, f.from, f.into)).toThrow();
});

it("refuses two definitions sharing one reference even with different verified profile bytes", () => {
  const f = fixture(), second = f.stageProfile({ ...f.profile, title: "Second definition" });
  expect(() => importWorkAgentCatalog({ ...f.catalog, profiles: [f.catalog.profiles[0]!, second] }, f.from, f.into)).toThrow(/DefinitionConflict/);
});

it.each(["userinfo", "query", "fragment", "non-http"] as const)("rejects a credential-bearing or unsupported endpoint: %s", kind => {
  const f = fixture();
  const endpoint = { userinfo: "http://user:secret@localhost/v1", query: "http://localhost/v1?key=secret", fragment: "http://localhost/v1#secret", "non-http": "file:///tmp/provider" }[kind];
  expect(workAgentProfileSchema.safeParse({ ...f.profile, endpoint }).success).toBe(false);
});

it("reads exact private JSON and accepts the one-MiB configuration boundary", () => {
  const f = fixture(), path = join(f.root, "agent.json");
  writeFileSync(path, JSON.stringify(f.catalog), { mode: 0o600 });
  expect(readWorkAgentConfiguration(path)).toEqual(f.catalog);
  const value = { padding: "x".repeat(1024 * 1024 - Buffer.byteLength('{"padding":""}')) };
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  expect(readWorkAgentConfiguration(path)).toEqual(value);
  writeFileSync(path, JSON.stringify({ padding: value.padding + "x" }), { mode: 0o600 });
  expect(() => readWorkAgentConfiguration(path)).toThrow(/ConfigurationUnavailable/);
});

it.each(["leaf-symlink", "parent-symlink", "hard-link", "public-mode", "directory", "relative", "malformed"] as const)("refuses private configuration %s", kind => {
  const f = fixture(), path = join(f.root, "agent.json");
  writeFileSync(path, JSON.stringify(f.catalog), { mode: 0o600 });
  let selected = path;
  if (kind === "leaf-symlink") { selected = join(f.root, "alias.json"); symlinkSync(path, selected); }
  if (kind === "parent-symlink") { const alias = join(f.root, "alias"); symlinkSync(f.from.root, alias); selected = join(alias, "config.json"); writeFileSync(join(f.from.root, "config.json"), "{}", { mode: 0o600 }); }
  if (kind === "hard-link") linkSync(path, join(f.root, "second.json"));
  if (kind === "public-mode") chmodSync(path, 0o644);
  if (kind === "directory") selected = f.root;
  if (kind === "relative") selected = "agent.json";
  if (kind === "malformed") writeFileSync(path, "{not JSON}");
  expect(() => readWorkAgentConfiguration(selected)).toThrow();
});
