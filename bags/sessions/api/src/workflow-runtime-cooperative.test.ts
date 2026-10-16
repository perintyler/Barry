/** Actual filesystem/CAS metadata units; compiler/native eligibility are mocked.
 * No retained worker execution, process proof or provider claim is made here. */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { WorkArtifactStore, type WorkArtifactRef } from "@barry-rocks/sdk/internal/workflows";
import { captureWorkflowRuntime, materializeWorkflowRuntime, materializeWorkflowRuntimeCooperatively,
  type WorkflowRuntimeManifest, type WorkflowRuntimeReference } from "./workflow-runtime-closure.js";

vi.mock("@barry-rocks/sdk/internal/workflows", async importOriginal => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/workflows")>(),
  captureOwnedProcessEntrypoint: vi.fn(() => Buffer.from("// metadata-only worker\n")),
  captureOwnedProcessBootstrap: vi.fn(() => Buffer.from("// metadata-only guardian\n")),
}));
vi.mock("./workflow-runtime-native.js", () => ({
  workflowRuntimeNativeIdentity: () => "cooperative-unit-native-metadata",
  assertWorkflowRuntimeNativeFiles: vi.fn(), isWorkflowRuntimeNativeImage: () => false,
}));
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close();vi.restoreAllMocks(); });
const artifact = (value: { digest: string; bytes: number }): WorkArtifactRef => ({ digest: value.digest, bytes: value.bytes, owner_identity: null, purpose: "source", media_type: "application/octet-stream" });
function packageAt(path: string, name: string, dependencies: Record<string, string> = {}) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.js", dependencies }));
  writeFileSync(join(path, "index.js"), "export default {id:'cooperative-unit'};\n");
}
function fixture(files = 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "runtime-cooperative-")));cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = new WorkArtifactStore(join(root, "artifacts"));cleanup.push(() => artifacts.close());
  const adapter = join(root, "adapter"), dependency = join(root, "dependency");
  packageAt(adapter, "cooperative-adapter", { "cooperative-dependency": "1.0.0" });packageAt(dependency, "cooperative-dependency");
  mkdirSync(join(adapter, "node_modules"));symlinkSync(relative(join(adapter, "node_modules"), dependency), join(adapter, "node_modules/cooperative-dependency"), "dir");
  mkdirSync(join(adapter, "assets"));writeFileSync(join(adapter, "assets/binary.dat"), Buffer.from([0, 1, 2, 255]));
  mkdirSync(join(adapter, "bin"));writeFileSync(join(adapter, "bin/tool"), "#!/bin/sh\nexit 0\n");chmodSync(join(adapter, "bin/tool"), 0o500);
  symlinkSync("index.js", join(adapter, "alias.js"));
  for (let index = 0; index < files; index++) writeFileSync(join(adapter, "assets", `small-${String(index).padStart(5, "0")}.txt`), `retained resource ${index}\n`);
  const worker = join(root, "worker.mjs"), runtime = join(root, "node-metadata");writeFileSync(worker, "// compiler fixture\n");writeFileSync(runtime, "metadata-only executable bytes\n");
  const ref = captureWorkflowRuntime({ artifacts, allowedRoots: [root], harness: "cooperative-unit", adapterModule: pathToFileURL(join(adapter, "index.js")).href,
    workerEntrypoint: worker, runtime, nodeVersion: "v26.11.1" });
  const manifest = JSON.parse(artifacts.verify(artifact(ref)).toString("utf8")) as WorkflowRuntimeManifest;
  return { root, artifacts, ref, manifest };
}
function tree(root: string): unknown[] {
  const entries: unknown[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), info = lstatSync(path), key = relative(root, path), mode = info.mode & 0o777;
      if (info.isSymbolicLink()) { const target = readlinkSync(path);expect(isAbsolute(target)).toBe(false);entries.push({ key, mode, target }); }
      else if (info.isDirectory()) { entries.push({ key, mode, directory: true });visit(path); }
      else entries.push({ key, mode, bytes: info.size, digest: createHash("sha256").update(readFileSync(path)).digest("hex") });
    }
  };
  visit(root);return entries;
}

it("materializes identical retained bytes, modes, package edges, internal aliases and manifest through either driver", async () => {
  const f = fixture(24), syncRoot = join(f.root, "sync"), asyncRoot = join(f.root, "cooperative");
  const original = materializeWorkflowRuntime(f.artifacts, f.ref, "cooperative-unit", syncRoot);
  const cooperative = await materializeWorkflowRuntimeCooperatively(f.artifacts, f.ref, "cooperative-unit", asyncRoot);
  expect(tree(asyncRoot)).toEqual(tree(syncRoot));expect(cooperative.manifest).toEqual(original.manifest);
  expect(cooperative.guardian.equals(original.guardian)).toBe(true);
  for (const key of ["runtime", "worker", "guard", "adapter"] as const) expect(relative(asyncRoot, cooperative[key])).toBe(relative(syncRoot, original[key]));
  expect(readFileSync(join(asyncRoot, ".closure.json")).equals(f.artifacts.verify(artifact(f.ref)))).toBe(true);
});

it("services scheduled timers while a real many-file materialization is incomplete", async () => {
  const f = fixture(1280), directory = join(f.root, "cooperative"), observations: number[] = [];
  const timer = setInterval(() => {
    if (existsSync(directory) && !existsSync(join(directory, ".closure.json"))) {
      const entries = readdirSync(directory);
      if (entries.length) observations.push(entries.length);
    }
  }, 0);
  try { await materializeWorkflowRuntimeCooperatively(f.artifacts, f.ref, "cooperative-unit", directory); }
  finally { clearInterval(timer); }
  expect(observations.length).toBeGreaterThan(0);
  expect(readFileSync(join(directory, ".closure.json")).equals(f.artifacts.verify(artifact(f.ref)))).toBe(true);
  expect(f.manifest.files.length).toBeGreaterThan(1280);
});

it.each(["chunk", "file-digest"] as const)("refuses corrupted retained %s before publishing an executable destination with either driver", async corruption => {
  const f = fixture(), syncRoot = join(f.root, "sync-rejected"), asyncRoot = join(f.root, "cooperative-rejected");
  let ref: WorkflowRuntimeReference = f.ref;
  if (corruption === "chunk") {
    const chunk = f.manifest.chunks[0], path = f.artifacts.path(artifact(chunk));chmodSync(path, 0o600);writeFileSync(path, Buffer.alloc(chunk.bytes, 0));
  } else {
    const value = structuredClone(f.manifest);value.files[0].content.digest = "f".repeat(64);
    const retained = f.artifacts.stage(Buffer.from(JSON.stringify(value)), { owner_identity: null, purpose: "source", media_type: "application/octet-stream" });
    ref = { version: 1, protocol: 1, digest: retained.digest, bytes: retained.bytes };
  }
  expect(() => materializeWorkflowRuntime(f.artifacts, ref, "cooperative-unit", syncRoot)).toThrow();
  await expect(materializeWorkflowRuntimeCooperatively(f.artifacts, ref, "cooperative-unit", asyncRoot)).rejects.toThrow();
  expect(existsSync(syncRoot)).toBe(false);expect(existsSync(asyncRoot)).toBe(false);
});
