import { createHash } from "node:crypto";
import { realpathSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { readBoundedFile } from "./read-bounded.js";
import type { WorkArtifactStore } from "./work-artifacts.js";
import { WorkflowError } from "./errors.js";

const relativePath = z.string().min(1).max(4096).refine(value => !value.includes("\\") && !value.includes("\0") && value.split("/").every(part => part && part !== "." && part !== ".."));
const file = z.strictObject({ path: relativePath, origin: z.string().max(4096).refine(value => isAbsolute(value) && !value.includes("\0")), digest: z.string().regex(/^[a-f0-9]{64}$/), mode: z.union([z.literal(0o400), z.literal(0o500)]), data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/) });
const bundleSchema = z.strictObject({ version: z.literal(1), files: z.array(file).min(1).max(10000) });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, path: string) => { const name = relative(root, path); return name !== ".." && !name.startsWith("../") && !isAbsolute(name); };
const forbidden = (path: string) => path.split("/").some(part => /^\.env(?:\.|$)/i.test(part) || [".git", ".ssh", ".barry", "secrets", "credentials"].includes(part.toLowerCase()));

/** Trusted internal resource manifest, never public task input. No dependency
 * installation or application execution occurs while retaining the closure. */
export function prepareProcessBundle(options: {
  artifacts: WorkArtifactStore; allowedRoots: string[];
  files: { path: string; source: string }[];
}) {
  const roots = options.allowedRoots.map(root => realpathSync(root));
  if (!options.files.length || options.files.length > 10000) throw new WorkflowError("WorkSourceManifestInvalid", "Source closure needs a bounded file manifest.", 409);
  const names = new Set<string>(); let bytes = 0;
  const files = options.files.map(item => {
    const path = relativePath.parse(item.path), source = realpathSync(item.source);
    if (names.has(path) || forbidden(path) || !roots.some(root => inside(root, source) && !forbidden(relative(root, source))))
      throw new WorkflowError("WorkSourceManifestInvalid", "Source closure has duplicate, private or escaping paths.", 409);
    names.add(path);
    const data = readBoundedFile(source, options.artifacts.maxArtifactBytes);
    bytes += data.length;
    if (bytes > options.artifacts.maxArtifactBytes) throw new WorkflowError("WorkSourceManifestInvalid", "Source closure exceeds its retained byte budget.", 409);
    return { path, origin: source, digest: hash(data), mode: statSync(source).mode & 0o111 ? 0o500 as const : 0o400 as const, data: data.toString("base64") };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = bundleSchema.parse({ version: 1, files });
  // A file cannot also be an ancestor directory of another retained file.
  for (const item of files) for (let parent = dirname(item.path); parent !== "."; parent = dirname(parent))
    if (names.has(parent)) throw new WorkflowError("WorkSourceManifestInvalid", "Source closure file/directory paths conflict.", 409);
  const source = options.artifacts.stage(Buffer.from(JSON.stringify(manifest)), { purpose: "source", owner_identity: null, media_type: "application/vnd.barry.process-bundle+json" });
  return { source, files: files.map(({ data: _data, ...item }) => item) };
}

export function readProcessBundle(bytes: Buffer) {
  const value = bundleSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const names = new Set<string>();
  for (const item of value.files) {
    const data = Buffer.from(item.data, "base64");
    if (names.has(item.path) || forbidden(item.path) || data.toString("base64") !== item.data || hash(data) !== item.digest) throw new Error("Invalid retained source closure.");
    names.add(item.path);
  }
  for (const item of value.files) for (let parent = dirname(item.path); parent !== "."; parent = dirname(parent))
    if (names.has(parent)) throw new Error("Conflicting retained source closure paths.");
  return value;
}

/** Parent-owned private directory; no symlinks or paths outside the bundle. */
export function materializeProcessBundle(bytes: Buffer, directory: string): void {
  const bundle = readProcessBundle(bytes);
  for (const item of bundle.files) {
    const path = join(directory, item.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, Buffer.from(item.data, "base64"), { mode: item.mode, flag: "wx" });
  }
}
