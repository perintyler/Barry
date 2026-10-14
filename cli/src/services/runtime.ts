import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { releaseRoot } from "../releases/release.js";
import { barryCacheDir } from "@barry-rocks/sdk/services";

/**
 * The Node every system service runs: nodejs.org's official macOS build, which
 * links only system libraries. `barry setup` downloads it as the user and
 * `sudo barry setup --system` verifies and installs it root-owned, so the user
 * cannot replace the interpreter that runs as the service account.
 *
 * The major must match the Node the workspace builds native modules with: the
 * vault's better-sqlite3 is compiled for that ABI (runtime.test.ts fails when
 * they differ). Moving it updates node-runtime.json with the version and both
 * digests from
 * https://nodejs.org/dist/v<version>/SHASUMS256.txt.
 */
export const NodePinSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  sha256: z.object({ arm64: z.string().regex(/^[0-9a-f]{64}$/), x64: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
}).strict();
type NodePin = z.infer<typeof NodePinSchema>;
const NODE_PIN = NodePinSchema.parse(JSON.parse(readFileSync(new URL("./node-runtime.json", import.meta.url), "utf8")));

export interface NodeRuntime {
  version: string;
  /** The tarball's top directory, and the installed runtime's directory name. */
  name: string;
  url: string;
  sha256: string;
}
export function nodeRuntime(arch: string = process.arch, pin: NodePin = NODE_PIN): NodeRuntime {
  const sha256 = arch === "arm64" || arch === "x64" ? pin.sha256[arch] : undefined;
  if (!sha256) throw new Error(`no pinned Node runtime for darwin-${arch}`);
  const name = `node-v${pin.version}-darwin-${arch}`;
  return { version: pin.version, name, sha256, url: `https://nodejs.org/dist/v${pin.version}/${name}.tar.gz` };
}
/** Where `barry setup` keeps the tarball for the privileged pass, which has no network. */
export function runtimeTarball(runtime: NodeRuntime = nodeRuntime(), root = releaseRoot()): string {
  const shipped = join(root, "runtime", `${runtime.name}.tar.gz`);
  if (existsSync(shipped)) return shipped;
  return join(barryCacheDir(), "runtime", `${runtime.name}.tar.gz`);
}
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type Download = (url: string) => Promise<Uint8Array>;
async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
/** Fetch the pinned tarball unless the cached one already matches. Answers whether it fetched. */
export async function downloadRuntime(
  fetchTarball: Download = download,
  runtime: NodeRuntime = nodeRuntime(),
  path: string = runtimeTarball(runtime),
  root: string = releaseRoot(),
): Promise<boolean> {
  if (existsSync(path) && sha256(readFileSync(path)) === runtime.sha256) return false;
  if (resolve(path) === resolve(root, "runtime", `${runtime.name}.tar.gz`)) {
    throw new Error(`${path} does not match its pinned SHA-256; reinstall this release`);
  }
  const bytes = await fetchTarball(runtime.url);
  if (sha256(bytes) !== runtime.sha256) throw new Error(`${runtime.url} does not match its pinned SHA-256`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes, { mode: 0o644 });
  renameSync(temporary, path);
  return true;
}
