/** Installation-owned executable snapshots. No installed application is imported
 * while capturing its package graph, and no dependency installation occurs. */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { arch, platform } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { z } from "zod";
import { type WorkArtifactRef, type WorkArtifactStore, captureOwnedProcessBootstrap, captureOwnedProcessEntrypoint } from "@barry-rocks/sdk/internal/workflows";
import { workflowRuntimeNativeIdentity, assertWorkflowRuntimeNativeFiles, isWorkflowRuntimeNativeImage } from "./workflow-runtime-native.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safePath = z.string().min(1).max(4096).refine(value => !value.includes("\\") && !value.includes("\0") && value.split("/").every(part => part && part !== "." && part !== ".."));
const packageName = z.string().regex(/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/);
const blobSchema = z.strictObject({ digest, bytes: z.number().int().nonnegative() });
const packageSchema = z.strictObject({ id: z.string().regex(/^p[0-9]+$/), name: packageName, version: z.string().min(1), dependencies: z.record(packageName, z.string().regex(/^p[0-9]+$/)), absentOptional: z.array(packageName) });
const fileSchema = z.strictObject({ path: safePath, content: blobSchema, storage: z.strictObject({ chunk: digest, offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }), executable: z.boolean() });
export const workflowRuntimeReferenceSchema = z.strictObject({ version: z.literal(1), digest, bytes: z.number().int().positive(), protocol: z.literal(1) });
export type WorkflowRuntimeReference = z.infer<typeof workflowRuntimeReferenceSchema>;
const manifestSchema = z.strictObject({
  version: z.literal(2), protocol: z.literal(1), harness: z.string().min(1).max(200),
  platform: z.string().min(1), arch: z.string().min(1), nodeVersion: z.string().regex(/^v26\./), nativeIdentity: z.string().min(1),
  adapter: safePath, files: z.array(fileSchema).min(4).max(100000), packages: z.array(packageSchema).min(1).max(2000),
  chunks: z.array(blobSchema).min(1).max(100000),
  links: z.array(z.strictObject({ path: safePath, target: safePath })).max(100000),
});
export type WorkflowRuntimeManifest = z.infer<typeof manifestSchema>;
const mediaType = "application/octet-stream";
const maximumBytes = 1_073_741_824;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function reference(blob: { digest: string; bytes: number }): WorkArtifactRef {
  return { digest: blob.digest, bytes: blob.bytes, purpose: "source", owner_identity: null, media_type: mediaType };
}
function inside(root: string, path: string): boolean {
  const name = relative(root, path);return name !== ".." && !name.startsWith("../") && !isAbsolute(name);
}
function readRegular(path: string, maximum: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximum) throw new Error("WorkflowRuntimeFileUnavailable");
    const buffer = Buffer.alloc(before.size + 1);let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, length);if (!count) break;length += count; }
    const bytes = buffer.subarray(0, length), after = fstatSync(fd);
    const current = lstatSync(path);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.isSymbolicLink() || realpathSync(path) !== path || current.dev !== after.dev || current.ino !== after.ino) throw new Error("WorkflowRuntimeFileChanged");
    return bytes;
  } finally { closeSync(fd); }
}
function owningPackage(entry: string): string {
  for (let current = dirname(realpathSync(entry));; current = dirname(current)) {
    if (existsSync(join(current, "package.json"))) return current;
    if (dirname(current) === current) throw new Error("WorkflowRuntimePackageUnavailable");
  }
}
function dependencyRoot(root: string, name: string): string | undefined {
  packageName.parse(name);
  // Node's normal realpath package context, including pnpm peer instances.
  // No preserve-symlinks flags or global name-to-package flattening.
  for (let current = root;; current = dirname(current)) {
    if (basename(current) !== "node_modules") {
      const candidate = join(current, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    }
    if (dirname(current) === current) return undefined;
  }
}
const excluded = new Set(["node_modules", ".git", ".hg", ".svn", ".barry", ".ssh", ".npmrc", ".netrc", ".yarnrc.yml", "credentials", "secrets"]);
function privateName(name: string): boolean { return excluded.has(name.toLowerCase()) || /^\.env(?:\.|$)/i.test(name) || /^(?:auth|credentials)\.json$/i.test(name); }

/** Capture before destination admission. The returned identity, not source
 * paths or a catalog version, must be retained in the accepted selection. */
export function captureWorkflowRuntime(options: {
  artifacts: WorkArtifactStore; harness: string; adapterModule: string; workerEntrypoint: string; allowedRoots: string[];
  runtime?: string; nodeVersion?: string; maxFiles?: number; maxBytes?: number;
}): WorkflowRuntimeReference {
  const adapterUrl = new URL(options.adapterModule);
  if (adapterUrl.protocol !== "file:" || adapterUrl.search || adapterUrl.hash || !isAbsolute(options.workerEntrypoint)) throw new Error("WorkflowRuntimeEntryUnavailable");
  const maxFiles = options.maxFiles ?? 100000, maxBytes = options.maxBytes ?? maximumBytes;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 4 || maxFiles > 100000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maximumBytes) throw new Error("WorkflowRuntimeBudgetUnavailable");
  const files: WorkflowRuntimeManifest["files"] = [], packages: WorkflowRuntimeManifest["packages"] = [];
  const allowedRoots = options.allowedRoots.map(root => realpathSync(root));
  if (!allowedRoots.length || allowedRoots.some(root => root.split(/[\\/]/).some(part => [".ssh", "secrets", "credentials"].includes(part.toLowerCase())) || privateName(basename(root)))) throw new Error("WorkflowRuntimeInstallationRootsUnavailable");
  const allowedPackage = (root: string) => !root.split(/[\\/]/).some(part => [".ssh", "secrets", "credentials"].includes(part.toLowerCase()))
    && allowedRoots.some(allowed => inside(allowed, root) && !relative(allowed, root).split(/[\\/]/).some(part => part.toLowerCase() !== "node_modules" && privateName(part)));
  const roots = new Map<string, string>(), queue: string[] = [], nativeFiles: { source: string; bytes: Buffer }[] = [];
  const packageLinks: { path: string; target: string }[] = [];
  // Whole small files share bounded durable CAS chunks. Content identity stays
  // per file; storage identity never becomes the module integrity hash.
  const chunks = new Map<string, { digest: string; bytes: number }>();
  const chunkLimit = Math.min(4_194_304, options.artifacts.maxArtifactBytes);
  let pending: { file: WorkflowRuntimeManifest["files"][number]; bytes: Buffer }[] = [], pendingBytes = 0;
  const stageChunk = (bytes: Buffer) => {
    const blob = options.artifacts.stage(bytes, { purpose: "source", owner_identity: null, media_type: mediaType });
    chunks.set(blob.digest, { digest: blob.digest, bytes: blob.bytes });return blob.digest;
  };
  const flush = () => {
    if (!pending.length) return;
    const chunk = stageChunk(Buffer.concat(pending.map(item => item.bytes), pendingBytes));
    for (const item of pending) item.file.storage.chunk = chunk;
    pending = [];pendingBytes = 0;
  };
  let total = 0;
  const add = (path: string, bytes: Buffer, executable = false, source?: string) => {
    safePath.parse(path);total += bytes.length;
    if (files.length >= maxFiles || total > maxBytes) throw new Error("WorkflowRuntimeBudgetExceeded");
    const file = { path, content: { digest: hash(bytes), bytes: bytes.length }, storage: { chunk: "", offset: 0 }, executable };
    if (bytes.length > chunkLimit) { flush();file.storage.chunk = stageChunk(bytes); }
    else {
      if (pendingBytes + bytes.length > chunkLimit) flush();
      file.storage.offset = pendingBytes;pending.push({ file, bytes });pendingBytes += bytes.length;
    }
    files.push(file);
    if (source && (executable || source === runtime || /\.(?:node|dylib)$/.test(source)) && isWorkflowRuntimeNativeImage(bytes)) nativeFiles.push({ source, bytes });
  };
  const enqueue = (root: string): string => {
    const canonical = realpathSync(root), known = roots.get(canonical);if (known) return known;
    if (!allowedPackage(canonical)) throw new Error("WorkflowRuntimePackageRootForbidden");
    for (const other of roots.keys()) {
      const nested = inside(other, canonical) ? relative(other, canonical) : inside(canonical, other) ? relative(canonical, other) : undefined;
      if (nested !== undefined && !nested.split(/[\\/]/).includes("node_modules")) throw new Error("WorkflowRuntimePackageRootOverlapUnsupported");
    }
    if (queue.length >= 2000) throw new Error("WorkflowRuntimePackageBudgetExceeded");
    const id = "p" + queue.length;roots.set(canonical, id);queue.push(canonical);return id;
  };
  const adapter = realpathSync(fileURLToPath(adapterUrl)), adapterRoot = owningPackage(adapter), adapterId = enqueue(adapterRoot);
  const runtime = realpathSync(options.runtime ?? process.execPath);
  const nativeIdentity = workflowRuntimeNativeIdentity();
  add("runtime/node", readRegular(runtime, options.artifacts.maxArtifactBytes), true, runtime);
  add("worker.mjs", captureOwnedProcessEntrypoint(options.workerEntrypoint));
  add("guardian.mjs", captureOwnedProcessBootstrap());
  add("guard.mjs", readRegular(fileURLToPath(new URL("./workflow-runtime-guard.mjs", import.meta.url)), options.artifacts.maxArtifactBytes));
  for (let index = 0; index < queue.length; index++) {
    const root = queue[index], id = roots.get(root)!;
    const metadata = JSON.parse(readRegular(join(root, "package.json"), 4_194_304).toString("utf8")) as {
      name: string; version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      bundledDependencies?: string[] | boolean; bundleDependencies?: string[] | boolean;
    };
    const dependencies: Record<string, string> = Object.create(null), absentOptional: string[] = [];
    const bundled = metadata.bundledDependencies ?? metadata.bundleDependencies;
    if (bundled !== undefined && typeof bundled !== "boolean" && (!Array.isArray(bundled) || bundled.some(name => typeof name !== "string"))) throw new Error("WorkflowRuntimePackageMetadataInvalid");
    const names = [...new Set([...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.optionalDependencies ?? {}), ...Object.keys(metadata.peerDependencies ?? {}), ...(Array.isArray(bundled) ? bundled : [])])].sort();
    for (const name of names) {
      const dependency = dependencyRoot(root, name);
      if (dependency) dependencies[name] = enqueue(dependency);
      else if (Object.hasOwn(metadata.optionalDependencies ?? {}, name) || metadata.peerDependenciesMeta?.[name]?.optional === true) absentOptional.push(name);
      else throw new Error("WorkflowRuntimeRequiredDependencyUnavailable: " + name);
    }
    packages.push(packageSchema.parse({ id, name: metadata.name, version: metadata.version, dependencies, absentOptional }));
    const walk = (directory: string, ancestors: Set<string>) => {
      const actual = realpathSync(directory);
      if (!inside(root, actual) || relative(root, actual).split(/[\\/]/).some(privateName) || ancestors.has(actual)) throw new Error("WorkflowRuntimeResourceEscape");
      const next = new Set(ancestors);next.add(actual);
      for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        if (privateName(item.name)) continue;
        const source = join(directory, item.name), resolved = realpathSync(source), info = lstatSync(resolved);
        if (!inside(root, resolved) || relative(root, resolved).split(/[\\/]/).some(privateName)) throw new Error("WorkflowRuntimeResourceEscape");
        if (item.isSymbolicLink()) {
          // Preserve Node's realpath module identity. Flattening an alias into
          // copied bytes can execute module initialization twice.
          packageLinks.push({ path: `packages/${id}/${relative(root, source).split("\\").join("/")}`, target: resolved });
          if (packageLinks.length > maxFiles) throw new Error("WorkflowRuntimeBudgetExceeded");
          continue;
        }
        if (info.isDirectory()) walk(source, next);
        else if (info.isFile()) add(`packages/${id}/${relative(root, source).split("\\").join("/")}`, readRegular(resolved, options.artifacts.maxArtifactBytes), Boolean(info.mode & 0o111), resolved);
        else throw new Error("WorkflowRuntimeResourceUnavailable");
      }
    };
    walk(root, new Set());
  }
  assertWorkflowRuntimeNativeFiles(nativeFiles, runtime, nativeIdentity);
  flush();
  const links = packageLinks.map(link => {
    const owner = [...roots.keys()].filter(root => inside(root, link.target)).sort((a, b) => b.length - a.length)[0];
    if (!owner) throw new Error("WorkflowRuntimeResourceEscape");
    const name = relative(owner, link.target);
    return { path: link.path, target: `packages/${roots.get(owner)!}${name ? "/" + name.split("\\").join("/") : ""}` };
  }).sort((a, b) => a.path < b.path ? -1 : 1);
  const manifest = manifestSchema.parse({ version: 2, protocol: 1, harness: options.harness, platform: platform(), arch: arch(), nodeVersion: options.nodeVersion ?? process.version,
    nativeIdentity, adapter: `packages/${adapterId}/${relative(adapterRoot, adapter).split("\\").join("/")}`, files: files.sort((a, b) => a.path < b.path ? -1 : 1), packages, links, chunks: [...chunks.values()].sort((a, b) => a.digest < b.digest ? -1 : 1) });
  validateManifest(manifest);
  const retained = options.artifacts.stage(Buffer.from(JSON.stringify(manifest)), { purpose: "source", owner_identity: null, media_type: mediaType });
  // Installed generations survive catalog replacement, staging GC and uncertain
  // executions. Retirement needs an explicit qualified reference inventory.
  for (const chunk of manifest.chunks) options.artifacts.retainExecutor(reference(chunk));
  options.artifacts.retainExecutor(retained);
  return workflowRuntimeReferenceSchema.parse({ version: 1, protocol: 1, digest: retained.digest, bytes: retained.bytes });
}
function validateManifest(manifest: WorkflowRuntimeManifest): void {
  const names = new Set(manifest.files.map(file => file.path)), ids = new Set(manifest.packages.map(item => item.id));
  const chunks = new Map(manifest.chunks.map(chunk => [chunk.digest, chunk]));
  if (chunks.size !== manifest.chunks.length || manifest.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) > maximumBytes
    || manifest.files.reduce((sum, file) => sum + file.content.bytes, 0) > maximumBytes) throw new Error("WorkflowRuntimeManifestInvalid");
  const ranges = new Map<string, WorkflowRuntimeManifest["files"]>();
  for (const file of manifest.files) {
    const chunk = chunks.get(file.storage.chunk), end = file.storage.offset + file.content.bytes;
    if (!chunk || !Number.isSafeInteger(end) || end > chunk.bytes) throw new Error("WorkflowRuntimeManifestInvalid");
    const entries = ranges.get(chunk.digest) ?? [];entries.push(file);ranges.set(chunk.digest, entries);
  }
  for (const chunk of chunks.values()) {
    const entries = ranges.get(chunk.digest);
    if (!entries) throw new Error("WorkflowRuntimeManifestInvalid");
    let end = 0;
    for (const file of entries.sort((a, b) => a.storage.offset - b.storage.offset || a.content.bytes - b.content.bytes)) {
      const start = file.storage.offset;
      // Identical chunks may deduplicate across flushes with different file
      // boundaries. Require complete byte coverage; each overlapping range's
      // independent content hash is verified before any path is created.
      if (file.content.bytes) {
        if (start > end) throw new Error("WorkflowRuntimeManifestInvalid");
        end = Math.max(end, start + file.content.bytes);
      }
    }
    if (end !== chunk.bytes) throw new Error("WorkflowRuntimeManifestInvalid");
  }
  const links = new Set(manifest.links.map(link => link.path));
  if (links.size !== manifest.links.length || [...links].some(path => names.has(path))) throw new Error("WorkflowRuntimeManifestInvalid");
  if (names.size !== manifest.files.length || ids.size !== manifest.packages.length || !names.has(manifest.adapter) || ["runtime/node", "worker.mjs", "guardian.mjs", "guard.mjs"].some(name => !names.has(name))) throw new Error("WorkflowRuntimeManifestInvalid");
  for (const file of manifest.files) {
    for (let parent = dirname(file.path); parent !== "."; parent = dirname(parent)) if (names.has(parent) || links.has(parent)) throw new Error("WorkflowRuntimeManifestInvalid");
    if (file.path.startsWith("packages/") && (!ids.has(file.path.split("/")[1]) || file.path.split("/").slice(2).some(privateName))) throw new Error("WorkflowRuntimeManifestInvalid");
  }
  for (const link of manifest.links) {
    const parts = link.path.split("/");
    if (parts[0] !== "packages" || !ids.has(parts[1]) || parts.length < 3 || parts.slice(2).some(privateName)
      || ![...names].some(path => path === link.target || path.startsWith(link.target + "/"))) throw new Error("WorkflowRuntimeManifestInvalid");
    for (let parent = dirname(link.path); parent !== "."; parent = dirname(parent)) if (names.has(parent) || links.has(parent)) throw new Error("WorkflowRuntimeManifestInvalid");
  }
  for (const item of manifest.packages) {
    if (!names.has(`packages/${item.id}/package.json`) || Object.values(item.dependencies).some(id => !ids.has(id))) throw new Error("WorkflowRuntimeManifestInvalid");
  }
}

type MaterializedWorkflowRuntime = { manifest: WorkflowRuntimeManifest; runtime: string; worker: string; guardian: Buffer; guard: string; adapter: string };
/** One verification/publication sequence for both preparation schedulers. */
function* materializationSteps(artifacts: WorkArtifactStore, accepted: WorkflowRuntimeReference, harness: string, directory: string): Generator<void, MaterializedWorkflowRuntime> {
  const selected = workflowRuntimeReferenceSchema.parse(accepted), bytes = artifacts.verify(reference(selected));
  const manifest = manifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));validateManifest(manifest);
  if (manifest.harness !== harness || manifest.platform !== platform() || manifest.arch !== arch() || manifest.nativeIdentity !== workflowRuntimeNativeIdentity()) throw new Error("WorkflowRuntimeHostMismatch");
  if (!isAbsolute(directory)) throw new Error("WorkflowRuntimeDirectoryUnavailable");
  // Verify every storage blob once, and all logical ranges before publishing
  // any executable path. Retained payload buffers have an aggregate cap;
  // manifest metadata and transient verification buffers add memory overhead.
  const chunks = new Map<string, Buffer>();
  for (const chunk of manifest.chunks) { chunks.set(chunk.digest, artifacts.verify(reference(chunk)));yield; }
  const contents = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const content = chunks.get(file.storage.chunk)!.subarray(file.storage.offset, file.storage.offset + file.content.bytes);
    if (hash(content) !== file.content.digest) throw new Error("WorkflowRuntimeFileChanged");
    contents.set(file.path, content);
    yield;
  }
  mkdirSync(directory, { mode: 0o700 });
  if (realpathSync(directory) !== directory) throw new Error("WorkflowRuntimeDirectoryUnavailable");
  for (const file of manifest.files) {
    const path = join(directory, file.path);mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, contents.get(file.path)!, { mode: file.executable ? 0o500 : 0o400, flag: "wx" });
    yield;
  }
  for (const item of manifest.packages) for (const [name, id] of Object.entries(item.dependencies)) {
    const path = join(directory, "packages", item.id, "node_modules", name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });symlinkSync(relative(dirname(path), join(directory, "packages", id)), path, "dir");
    yield;
  }
  for (const link of manifest.links) {
    const path = join(directory, link.path);mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    symlinkSync(relative(dirname(path), join(directory, link.target)) || ".", path);
    yield;
  }
  writeFileSync(join(directory, ".closure.json"), bytes, { mode: 0o400, flag: "wx" });
  const folder = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(folder); } finally { closeSync(folder); }
  return { manifest, runtime: resolve(directory, "runtime/node"), worker: resolve(directory, "worker.mjs"), guardian: Buffer.from(contents.get("guardian.mjs")!), guard: resolve(directory, "guard.mjs"), adapter: resolve(directory, manifest.adapter) };
}

/** Fresh private destination only; never execute the content-store paths. */
export function materializeWorkflowRuntime(artifacts: WorkArtifactStore, accepted: WorkflowRuntimeReference, harness: string, directory: string): MaterializedWorkflowRuntime {
  const steps = materializationSteps(artifacts, accepted, harness, directory);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** Allow owner RPCs, Stop and deadlines between bounded preparation operations.
 * Individual filesystem/hash/manifest operations still depend on host latency. */
export async function materializeWorkflowRuntimeCooperatively(artifacts: WorkArtifactStore, accepted: WorkflowRuntimeReference, harness: string, directory: string): Promise<MaterializedWorkflowRuntime> {
  const steps = materializationSteps(artifacts, accepted, harness, directory);
  await yieldToEventLoop();
  let yieldedAt = performance.now(), next = steps.next();
  while (!next.done) {
    if (performance.now() - yieldedAt >= 8) { await yieldToEventLoop();yieldedAt = performance.now(); }
    next = steps.next();
  }
  return next.value;
}

/** Complete immutable custody inventory for owner admission/backup. */
export function workflowRuntimeArtifacts(artifacts: WorkArtifactStore, accepted: WorkflowRuntimeReference): WorkArtifactRef[] {
  const root = reference(workflowRuntimeReferenceSchema.parse(accepted));
  const manifest = manifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifacts.verify(root))));
  validateManifest(manifest);
  const sources = [root, ...manifest.chunks.map(reference)];
  for (const source of sources) artifacts.verify(source);
  return [...new Map(sources.map(source => [source.digest, source])).values()];
}
