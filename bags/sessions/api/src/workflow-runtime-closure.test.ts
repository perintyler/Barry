/** Real CAS/filesystem graph units. Compiler and host eligibility are mocked;
 * these tests make no worker execution, native eligibility or cessation claim. */
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkArtifactStore, type WorkArtifactRef } from "@barry-rocks/sdk/internal/workflows";
import { captureWorkflowRuntime, materializeWorkflowRuntime, type WorkflowRuntimeManifest, type WorkflowRuntimeReference } from "./workflow-runtime-closure.js";

vi.mock("@barry-rocks/sdk/internal/workflows", async importOriginal => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/workflows")>(),
  captureOwnedProcessEntrypoint: vi.fn(() => Buffer.from("// compiled worker metadata fixture\n")),
  captureOwnedProcessBootstrap: vi.fn(() => Buffer.from("// compiled guardian metadata fixture\n")),
}));
vi.mock("./workflow-runtime-native.js", () => ({
  workflowRuntimeNativeIdentity: () => "graph-unit-mocked-native-identity",
  assertWorkflowRuntimeNativeFiles: vi.fn(), isWorkflowRuntimeNativeImage: () => false,
}));

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose();vi.restoreAllMocks(); });
function packageAt(root: string, name: string, extra: Record<string, unknown> = {}, files: Record<string, string | Buffer> = {}): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.js", ...extra }));
  writeFileSync(join(root, "index.js"), "export default {id:'unit-harness'};\n");
  for (const [name, bytes] of Object.entries(files)) { mkdirSync(dirname(join(root, name)), { recursive: true });writeFileSync(join(root, name), bytes); }
  return root;
}
function edge(from: string, name: string, target: string): void {
  const link = join(from, "node_modules", name);mkdirSync(dirname(link), { recursive: true });symlinkSync(relative(dirname(link), target), link, "dir");
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-closure-unit-")));disposals.push(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = new WorkArtifactStore(join(root, "cas"));disposals.push(() => artifacts.close());
  const adapter = packageAt(join(root, "adapter"), "unit-adapter"), worker = join(root, "worker-entry.mjs"), runtime = join(root, "node-metadata");
  writeFileSync(worker, "// source for compiler mock\n");writeFileSync(runtime, "not a native executable: graph metadata only\n");
  const options = { artifacts, allowedRoots: [root], harness: "unit-harness", adapterModule: pathToFileURL(join(adapter, "index.js")).href, workerEntrypoint: worker, runtime, nodeVersion: "v26.11.1" };
  return { root, artifacts, adapter, options, capture: () => captureWorkflowRuntime(options), destination: () => join(root, "materialized") };
}
function artifact(ref: { digest: string; bytes: number }): WorkArtifactRef { return { digest: ref.digest, bytes: ref.bytes, purpose: "source", owner_identity: null, media_type: "application/octet-stream" }; }
function manifest(f: ReturnType<typeof fixture>, ref: WorkflowRuntimeReference): WorkflowRuntimeManifest { return JSON.parse(f.artifacts.verify(artifact(ref)).toString("utf8")); }
function retainManifest(f: ReturnType<typeof fixture>, value: unknown): WorkflowRuntimeReference {
  const retained = f.artifacts.stage(Buffer.from(JSON.stringify(value)), { purpose: "source", owner_identity: null, media_type: "application/octet-stream" });
  return { version: 1, protocol: 1, digest: retained.digest, bytes: retained.bytes };
}

it("retains exact installed package resources in actual CAS and materializes private code with internal relative edges", () => {
  const f = fixture();
  packageAt(f.adapter, "unit-adapter", { dependencies: { "unit-dependency": "1" } }, { "assets/schema.json": '{"original":true}', "assets/runtime.wasm": Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), "bin/tool": "#!/bin/sh\nexit 0\n" });
  chmodSync(join(f.adapter, "bin/tool"), 0o755);
  const dependency = packageAt(join(f.root, "dependency"), "unit-dependency", {}, { "resource.txt": "dependency original" });edge(f.adapter, "unit-dependency", dependency);
  const ref = f.capture(), before = manifest(f, ref);
  const own = before.packages.find(row => row.name === "unit-adapter")!, dep = before.packages.find(row => row.name === "unit-dependency")!;
  expect(own.dependencies).toEqual({ "unit-dependency": dep.id });
  expect(f.artifacts.executorRetained(createHash("sha256").update("null").digest("hex"), ref.digest)).toBe(true);
  writeFileSync(join(f.adapter, "assets/schema.json"), "mutated original");rmSync(dependency, { recursive: true });
  const output = materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination());
  expect(readFileSync(join(f.destination(), "packages", own.id, "assets/schema.json"), "utf8")).toBe('{"original":true}');
  expect(readFileSync(join(f.destination(), "packages", own.id, "assets/runtime.wasm"))).toEqual(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const link = join(f.destination(), "packages", own.id, "node_modules/unit-dependency");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);expect(isAbsolute(readlinkSync(link))).toBe(false);
  expect(realpathSync(link)).toBe(join(f.destination(), "packages", dep.id));
  expect(readFileSync(join(link, "resource.txt"), "utf8")).toBe("dependency original");
  expect(lstatSync(join(f.destination(), "packages", own.id, "bin/tool")).mode & 0o777).toBe(0o500);
  expect(lstatSync(output.adapter).mode & 0o777).toBe(0o400);expect(lstatSync(f.destination()).mode & 0o777).toBe(0o700);
  expect(output.runtime).toBe(join(f.destination(), "runtime/node"));
});

it("preserves distinct real package instances with equal name/version and their cyclic dependency contexts", () => {
  const f = fixture();packageAt(f.adapter, "unit-adapter", { dependencies: { left: "npm:shared@1", right: "npm:shared@1" } });
  const left = packageAt(join(f.root, "left"), "shared", { dependencies: { back: "npm:unit-adapter@1" } }, { "context.txt": "left peer context" });
  const right = packageAt(join(f.root, "right"), "shared", { dependencies: { back: "npm:unit-adapter@1" } }, { "context.txt": "right peer context" });
  edge(f.adapter, "left", left);edge(f.adapter, "right", right);edge(left, "back", f.adapter);edge(right, "back", f.adapter);
  const ref = f.capture(), value = manifest(f, ref), own = value.packages.find(row => row.name === "unit-adapter")!;
  expect(value.packages).toHaveLength(3);expect(own.dependencies.left).not.toBe(own.dependencies.right);
  for (const row of value.packages.filter(row => row.name === "shared")) expect(row.dependencies.back).toBe(own.id);
  materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination());
  expect(readFileSync(join(f.destination(), "packages", own.id, "node_modules/left/context.txt"), "utf8")).toBe("left peer context");
  expect(readFileSync(join(f.destination(), "packages", own.id, "node_modules/right/context.txt"), "utf8")).toBe("right peer context");
  expect(realpathSync(join(f.destination(), "packages", own.id, "node_modules/left/node_modules/back"))).toBe(join(f.destination(), "packages", own.id));
});

it("refuses overlapping non-node_modules package roots instead of assigning ambiguous module ownership", () => {
  const f = fixture();packageAt(f.adapter, "unit-adapter", { dependencies: { "nested-package": "1" } });
  const nested = packageAt(join(f.adapter, "embedded-package"), "nested-package", {}, { "resource.txt": "nested package bytes" });
  edge(f.adapter, "nested-package", nested);
  expect(() => f.capture()).toThrow("WorkflowRuntimePackageRootOverlapUnsupported");
});
it("records absent optional dependencies and explicitly optional peers without silently dropping a required peer", () => {
  const f = fixture();packageAt(f.adapter, "unit-adapter", { optionalDependencies: { "optional-native": "1" }, peerDependencies: { "optional-peer": "1" }, peerDependenciesMeta: { "optional-peer": { optional: true } } });
  expect(manifest(f, f.capture()).packages[0].absentOptional).toEqual(["optional-native", "optional-peer"]);
  packageAt(f.adapter, "unit-adapter", { peerDependencies: { "required-peer": "1" } });
  expect(() => f.capture()).toThrow("WorkflowRuntimeRequiredDependencyUnavailable: required-peer");
});
it("refuses a missing ordinary dependency instead of importing or installing it", () => {
  const f = fixture();packageAt(f.adapter, "unit-adapter", { dependencies: { "required-package": "1" } });
  expect(() => f.capture()).toThrow("WorkflowRuntimeRequiredDependencyUnavailable: required-package");
});
it("retains bundled dependencies excluded from the parent package walk as real graph instances", () => {
  const f = fixture();packageAt(f.adapter, "unit-adapter", { bundledDependencies: ["bundled-only"] });
  packageAt(join(f.adapter, "node_modules/bundled-only"), "bundled-only", {}, { "vendor.dat": "actual bundled resource" });
  const ref = f.capture(), value = manifest(f, ref), own = value.packages.find(row => row.name === "unit-adapter")!;
  expect(value.packages).toHaveLength(2);expect(own.dependencies["bundled-only"]).toBeDefined();
  materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination());
  expect(readFileSync(join(f.destination(), "packages", own.id, "node_modules/bundled-only/vendor.dat"), "utf8")).toBe("actual bundled resource");
});

it.each(["file", "directory"] as const)("refuses a package resource %s escape", kind => {
  const f = fixture();const outside = join(f.root, "outside");mkdirSync(outside);writeFileSync(join(outside, "resource"), "outside code");
  symlinkSync(kind === "file" ? join(outside, "resource") : outside, join(f.adapter, "alias"), kind === "file" ? "file" : "dir");
  expect(() => f.capture()).toThrow("WorkflowRuntimeResourceEscape");
});
it("preserves internal file/root aliases and actual Node module identity instead of copying a second initializer", () => {
  const f = fixture();
  writeFileSync(join(f.adapter, "real.js"), "globalThis.__workflowClosureLoads=(globalThis.__workflowClosureLoads??0)+1; export const identity={};\n");
  symlinkSync("real.js", join(f.adapter, "alias.js"));symlinkSync(".", join(f.adapter, "root-alias"), "dir");
  const ref = f.capture(), captured = manifest(f, ref), own = captured.packages.find(row => row.name === "unit-adapter")!;
  expect(captured.links).toEqual([{ path: `packages/${own.id}/alias.js`, target: `packages/${own.id}/real.js` }, { path: `packages/${own.id}/root-alias`, target: `packages/${own.id}` }]);
  expect(captured.files.some(file => file.path.endsWith("/alias.js") || file.path.includes("/root-alias/"))).toBe(false);
  materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination());
  const retainedRoot = join(f.destination(), "packages", own.id), alias = join(retainedRoot, "alias.js"), actual = join(retainedRoot, "real.js");
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);expect(readlinkSync(alias)).toBe("real.js");expect(realpathSync(alias)).toBe(actual);
  expect(realpathSync(join(retainedRoot, "root-alias"))).toBe(retainedRoot);
  // Actual Node imports only this inert unit module. This is module-cache
  // evidence, not worker launch, native eligibility or process cessation proof.
  const source = `const first=await import(${JSON.stringify(pathToFileURL(alias).href)});const second=await import(${JSON.stringify(pathToFileURL(actual).href)});process.stdout.write(JSON.stringify({same:first===second,loads:globalThis.__workflowClosureLoads}));`;
  const result = execFileSync(process.execPath, ["--input-type=module", "--eval", source], { cwd: f.destination(), env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 3000, maxBuffer: 4096 });
  expect(JSON.parse(result)).toEqual({ same: true, loads: 1 });
});
it.each([".env", "credentials", "secrets"])("refuses a public alias into private %s bytes before staging those bytes", privatePath => {
  const f = fixture(), secret = "private-unit-content-that-must-not-enter-CAS";
  const target = privatePath === ".env" ? join(f.adapter, privatePath) : join(f.adapter, privatePath, "value");mkdirSync(dirname(target), { recursive: true });writeFileSync(target, secret);
  symlinkSync(target, join(f.adapter, "public-alias.js"));
  const staged = vi.spyOn(f.artifacts, "stage");
  expect(() => f.capture()).toThrow("WorkflowRuntimeResourceEscape");
  expect(staged.mock.calls.some(([bytes]) => Buffer.from(bytes).includes(Buffer.from(secret)))).toBe(false);
});
it.each([".ssh", "secrets", "credentials"])("refuses an aliased whole dependency package under private %s before its bytes enter CAS", privateRoot => {
  const f = fixture(), secret = "whole-private-package-must-not-enter-retained-closure";
  packageAt(f.adapter, "unit-adapter", { dependencies: { "public-package-alias": "1" } });
  const target = packageAt(join(f.root, privateRoot, "pkg"), "private-package", {}, { "ordinary-resource.js": secret });
  edge(f.adapter, "public-package-alias", target);
  const staged = vi.spyOn(f.artifacts, "stage");
  expect(() => f.capture()).toThrow("WorkflowRuntimePackageRootForbidden");
  expect(staged.mock.calls.some(([bytes]) => bytes.includes(Buffer.from(secret)))).toBe(false);
});
it("requires explicit allowed installation roots and refuses a public dependency outside them", () => {
  const f = fixture();expect(() => captureWorkflowRuntime({ ...f.options, allowedRoots: [] })).toThrow("WorkflowRuntimeInstallationRootsUnavailable");
  packageAt(f.adapter, "unit-adapter", { dependencies: { "outside-approved-root": "1" } });
  const target = packageAt(join(f.root, "unapproved-package"), "outside-approved-root");edge(f.adapter, "outside-approved-root", target);
  expect(() => captureWorkflowRuntime({ ...f.options, allowedRoots: [f.adapter] })).toThrow("WorkflowRuntimePackageRootForbidden");
});
it("excludes private files while preserving ordinary package assets", () => {
  const f = fixture();writeFileSync(join(f.adapter, ".env"), "PRIVATE_SENTINEL");writeFileSync(join(f.adapter, "asset.txt"), "public");
  const value = manifest(f, f.capture());expect(value.files.some(file => file.path.endsWith("/.env"))).toBe(false);expect(value.files.some(file => file.path.endsWith("/asset.txt"))).toBe(true);
});
it("enforces total byte/file budgets without publishing a partial closure reference", () => {
  const f = fixture();expect(() => captureWorkflowRuntime({ ...f.options, maxFiles: 4 })).toThrow("WorkflowRuntimeBudgetExceeded");
  expect(() => captureWorkflowRuntime({ ...f.options, maxBytes: 1 })).toThrow("WorkflowRuntimeBudgetExceeded");
  expect(() => captureWorkflowRuntime({ ...f.options, maxFiles: 3 })).toThrow("WorkflowRuntimeBudgetUnavailable");
});
it("refuses corrupted actual CAS bytes instead of materializing them as executable code", () => {
  const f = fixture(), ref = f.capture(), value = manifest(f, ref), adapter = value.files.find(row => row.path === value.adapter)!;
  const chunk = value.chunks.find(row => row.digest === adapter.storage.chunk)!;
  const path = f.artifacts.path(artifact(chunk));chmodSync(path, 0o600);writeFileSync(path, "corrupted retained code");
  expect(() => materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination())).toThrow();
});
it.each(["duplicate", "package-id", "ancestor", "escape", "private", "edge"] as const)("rejects a hash-valid but structurally invalid %s manifest before making a destination", corruption => {
  const f = fixture(), value = manifest(f, f.capture());
  if (corruption === "duplicate") value.files.push({ ...value.files[0] });
  if (corruption === "package-id") value.packages.push(structuredClone(value.packages[0]));
  if (corruption === "ancestor") value.files.push({ ...value.files[0], path: "packages" });
  if (corruption === "escape") value.files[0].path = "../outside";
  if (corruption === "private") value.files.push({ ...value.files[0], path: "packages/p0/credentials/value" });
  if (corruption === "edge") value.packages[0].dependencies.missing = "p999";
  const ref = retainManifest(f, value);
  expect(() => materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination())).toThrow();expect(existsSync(f.destination())).toBe(false);
});
it.each(["traversal", "target-traversal", "file-conflict", "private", "missing-target", "duplicate", "ancestor"] as const)("rejects a hash-valid malformed internal link %s before creating a destination", corruption => {
  const f = fixture(), value = manifest(f, f.capture()), own = value.packages.find(row => row.name === "unit-adapter")!;
  const link = { path: `packages/${own.id}/alias.js`, target: value.adapter };
  if (corruption === "traversal") link.path = "../outside";
  if (corruption === "target-traversal") link.target = "../outside";
  if (corruption === "file-conflict") link.path = value.adapter;
  if (corruption === "private") link.path = `packages/${own.id}/credentials/alias.js`;
  if (corruption === "missing-target") link.target = `packages/${own.id}/missing.js`;
  if (corruption === "ancestor") value.files.push({ ...value.files[0], path: link.path + "/child.js" });
  value.links.push(link);if (corruption === "duplicate") value.links.push({ ...link });
  const ref = retainManifest(f, value);
  expect(() => materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination())).toThrow();expect(existsSync(f.destination())).toBe(false);
});
it("refuses an existing or aliased destination and a different selected harness", () => {
  const f = fixture(), ref = f.capture();mkdirSync(f.destination());
  expect(() => materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination())).toThrow();
  const alias = join(f.root, "alias");symlinkSync(f.destination(), alias, "dir");
  expect(() => materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", alias)).toThrow();
  expect(() => materializeWorkflowRuntime(f.artifacts, ref, "other-harness", join(f.root, "other"))).toThrow("WorkflowRuntimeHostMismatch");
});


it("packs many whole files into bounded actual CAS chunks while preserving empty, large and executable content", () => {
  const f = fixture(), expected = new Map<string, Buffer>();
  // More than one 4MiB chunk; real CAS writes, not a timing benchmark.
  for (let index = 0; index < 144; index++) {
    const name = `assets/item-${String(index).padStart(3, "0")}.dat`;
    const bytes = Buffer.alloc(40 * 1024, index);expected.set(name, bytes);
    mkdirSync(dirname(join(f.adapter, name)), { recursive: true });writeFileSync(join(f.adapter, name), bytes);
  }
  const large = Buffer.alloc(4 * 1024 * 1024 + 1, 173);
  expected.set("large.dat", large);expected.set("empty.dat", Buffer.alloc(0));expected.set("duplicate.dat", expected.get("assets/item-000.dat")!);
  for (const [name, bytes] of expected) writeFileSync(join(f.adapter, name), bytes);
  chmodSync(join(f.adapter, "large.dat"), 0o755);
  const staged = vi.spyOn(f.artifacts, "stage"), retained = vi.spyOn(f.artifacts, "retainExecutor");
  const ref = f.capture(), value = manifest(f, ref), own = value.packages.find(row => row.name === "unit-adapter")!;
  expect(value.version).toBe(2);expect(new Set(value.chunks.map(row => row.digest)).size).toBe(value.chunks.length);
  expect(staged.mock.calls.length).toBeLessThan(expected.size / 4);
  expect(retained.mock.calls.map(([row]) => row.digest).sort()).toEqual([...value.chunks.map(row => row.digest), ref.digest].sort());
  const namespace = createHash("sha256").update("null").digest("hex");
  for (const chunk of value.chunks) expect(f.artifacts.executorRetained(namespace, chunk.digest)).toBe(true);
  const largeFile = value.files.find(row => row.path === `packages/${own.id}/large.dat`)!;
  expect(largeFile.storage.offset).toBe(0);
  expect(value.chunks.find(row => row.digest === largeFile.storage.chunk)?.bytes).toBe(large.length);
  expect(value.chunks.filter(row => row.digest !== largeFile.storage.chunk).every(row => row.bytes <= 4 * 1024 * 1024)).toBe(true);
  rmSync(f.adapter, { recursive: true });materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination());
  for (const [name, bytes] of expected) expect(readFileSync(join(f.destination(), "packages", own.id, name)).equals(bytes), name).toBe(true);
  expect(lstatSync(join(f.destination(), "packages", own.id, "large.dat")).mode & 0o777).toBe(0o500);
});

it.each(["missing-chunk", "duplicate-chunk", "conflicting-chunk-size", "negative", "fractional", "overflow", "out-of-range", "overlap", "content-digest", "unreferenced-chunk"] as const)("rejects hash-valid packed storage %s before creating a destination", corruption => {
  const f = fixture(), value = manifest(f, f.capture()), first = value.files[0], second = value.files[1];
  const chunk = value.chunks.find(row => row.digest === first.storage.chunk)!;
  if (corruption === "missing-chunk") first.storage.chunk = "0".repeat(64);
  if (corruption === "duplicate-chunk") value.chunks.push({ ...chunk });
  if (corruption === "conflicting-chunk-size") value.chunks.push({ ...chunk, bytes: chunk.bytes + 1 });
  if (corruption === "negative") first.storage.offset = -1;
  if (corruption === "fractional") first.storage.offset = 0.5;
  if (corruption === "overflow") first.storage.offset = Number.MAX_SAFE_INTEGER;
  if (corruption === "out-of-range") first.storage.offset = chunk.bytes;
  if (corruption === "overlap") second.storage = { ...first.storage };
  if (corruption === "content-digest") first.content.digest = "0".repeat(64);
  if (corruption === "unreferenced-chunk") {
    const extra = f.artifacts.stage(Buffer.from("unreferenced chunk bytes"), { purpose: "source", owner_identity: null, media_type: "application/octet-stream" });
    value.chunks.push({ digest: extra.digest, bytes: extra.bytes });
  }
  const ref = retainManifest(f, value);
  expect(() => materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination())).toThrow();expect(existsSync(f.destination())).toBe(false);
});
it("refuses a legacy version1 manifest instead of interpreting it as packed storage", () => {
  const f = fixture(), value = manifest(f, f.capture()), ref = retainManifest(f, { ...value, version: 1 });
  expect(() => materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination())).toThrow();expect(existsSync(f.destination())).toBe(false);
});

it("accepts an exact shared packed range only when its logical content identity also matches", () => {
  const f = fixture(), value = manifest(f, f.capture()), original = value.files.find(row => row.path === value.adapter)!;
  const copied = { ...structuredClone(original), path: "packages/p0/shared-range.js" };value.files.push(copied);
  const ref = retainManifest(f, value);materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination());
  expect(readFileSync(join(f.destination(), copied.path))).toEqual(readFileSync(join(f.destination(), original.path)));
});
it("rejects hash-valid chunk padding that has no logical file owner", () => {
  const f = fixture(), value = manifest(f, f.capture()), original = value.chunks[0];
  const padded = f.artifacts.stage(Buffer.concat([f.artifacts.verify(artifact(original)), Buffer.from("unowned padding")]), { purpose: "source", owner_identity: null, media_type: "application/octet-stream" });
  value.chunks[0] = { digest: padded.digest, bytes: padded.bytes };
  for (const file of value.files) if (file.storage.chunk === original.digest) file.storage.chunk = padded.digest;
  const ref = retainManifest(f, value);
  expect(() => materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination())).toThrow();expect(existsSync(f.destination())).toBe(false);
});

it("deduplicates identical actual chunk bytes with different valid whole-file partitions", () => {
  const f = fixture(), first = Buffer.alloc(2 * 1024 * 1024, 65), second = Buffer.alloc(2 * 1024 * 1024, 66), whole = Buffer.concat([first, second]);
  mkdirSync(join(f.adapter, "assets"));
  // The oversized file flushes pending worker/package metadata, aligning the
  // following two complete files into the same bytes as the final whole file.
  writeFileSync(join(f.adapter, "assets/00-boundary.dat"), Buffer.alloc(4 * 1024 * 1024 + 1, 67));
  writeFileSync(join(f.adapter, "assets/01-first.dat"), first);writeFileSync(join(f.adapter, "assets/02-second.dat"), second);writeFileSync(join(f.adapter, "assets/03-whole.dat"), whole);
  const ref = f.capture(), value = manifest(f, ref), own = value.packages.find(row => row.name === "unit-adapter")!;
  const file = (name: string) => value.files.find(row => row.path === `packages/${own.id}/assets/${name}.dat`)!;
  expect(file("01-first").storage.chunk).toBe(file("03-whole").storage.chunk);
  expect(file("02-second").storage.chunk).toBe(file("03-whole").storage.chunk);
  expect(file("01-first").storage.offset).toBe(0);expect(file("02-second").storage.offset).toBe(first.length);expect(file("03-whole").storage.offset).toBe(0);
  expect(value.chunks.filter(chunk => chunk.digest === file("03-whole").storage.chunk)).toHaveLength(1);
  rmSync(f.adapter, { recursive: true });materializeWorkflowRuntime(f.artifacts, ref, "unit-harness", f.destination());
  for (const [name, bytes] of [["01-first", first], ["02-second", second], ["03-whole", whole]] as const) expect(readFileSync(join(f.destination(), "packages", own.id, "assets", name + ".dat")).equals(bytes), name).toBe(true);
});
