import { randomUUID } from "node:crypto";
import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { barryAppSupportDir, barryCurrentDir, barryReleasesDir, installationRoot } from "@barry-rocks/sdk/services";
import { runningNodePath } from "@barry-rocks/sdk/internal/services";
import { managedServices } from "@barry-rocks/mcp-bag";
import { readReceipts, type Installation } from "./receipts.js";
import { checkoutCommit } from "../services/specs.js";
import { readRelease, type Release } from "./release.js";

function currentStat() {
  try { return lstatSync(barryCurrentDir()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}

/** Replace only the selector, never the directory it points at. */
export function pointCurrent(target: string): void {
  const current = barryCurrentDir();
  const stat = currentStat();
  if (stat && !stat.isSymbolicLink()) throw new Error(`${current} is not a symbolic link; refusing to replace it`);
  mkdirSync(barryAppSupportDir(), { recursive: true });
  const absolute = resolve(target);
  const rel = relative(realpathSync(barryAppSupportDir()), existsSync(absolute) ? realpathSync(absolute) : absolute);
  const temporary = `${current}.${randomUUID()}.tmp`;
  try {
    symlinkSync(rel.startsWith(`releases${sep}`) && !isAbsolute(rel) ? rel : absolute, temporary);
    renameSync(temporary, current);
  } finally { rmSync(temporary, { force: true }); }
}

/** Stage a complete release before making its version available. */
export function copyRelease(root: string, release: Release): string {
  const target = join(barryReleasesDir(), release.version);
  if (existsSync(target)) {
    if (readRelease(target)?.commit !== release.commit) throw new Error(`${target} already holds a release with another commit`);
    return target;
  }
  mkdirSync(barryReleasesDir(), { recursive: true });
  const staged = mkdtempSync(join(barryReleasesDir(), `.${release.version}-`));
  try {
    cpSync(root, staged, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true, preserveTimestamps: true });
    if (!isDeepStrictEqual(readRelease(staged), release)) throw new Error(`copied release.json differs from ${root}`);
    renameSync(staged, target);
  } finally { rmSync(staged, { recursive: true, force: true }); }
  return target;
}

/** Validate the checkout and capture its Node before changing current. */
export function linkCheckout(path: string): { root: string; node: string } {
  const root = resolve(path);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Barry checkout does not exist: ${root}`);
  if (existsSync(join(root, "release.json"))) throw new Error(`${root} is a release; barry upgrade installs releases`);
  if (!existsSync(join(root, "identity.yaml"))) throw new Error(`${root} has no identity.yaml`);
  try { accessSync(join(root, "bin/barry"), constants.X_OK); }
  catch { throw new Error(`${root} has no executable bin/barry`); }
  // Not stableNodePath(): with a release current, that names the release's runtime.
  const node = process.env.BARRY_NODE || runningNodePath();
  try { accessSync(node, constants.X_OK); }
  catch { throw new Error(`BARRY_NODE must name an executable Node: ${node}`); }
  if (existsSync(join(dirname(realpathSync(node)), "..", "..", "release.json")))
    throw new Error(`The Node ${node} belongs to a release; set BARRY_NODE or run node ${root}/cli/bin/barry.js setup --link ${root}`);
  return { root: realpathSync(root), node };
}

export interface CurrentInstallation {
  current: boolean;
  kind: "checkout" | "release" | "link" | "missing";
  root: string;
  target?: string;
  version?: string;
  commit?: string;
}

export function currentInstallation(): CurrentInstallation {
  const current = barryCurrentDir();
  const stat = currentStat();
  if (stat) {
    if (!stat.isSymbolicLink()) throw new Error(`${current} is not a symbolic link; refusing to use it`);
    const target = resolve(dirname(current), readlinkSync(current));
    if (!existsSync(current)) return { current: true, kind: "missing", root: current, target };
    const release = readRelease(current);
    return release
      ? { current: true, kind: "release", root: current, target, version: release.version, commit: release.commit }
      : { current: true, kind: "link", root: current, target, commit: checkoutCommit(current) };
  }
  const root = installationRoot();
  const release = readRelease(root);
  return release
    ? { current: false, kind: "release", root, version: release.version, commit: release.commit }
    : { current: false, kind: "checkout", root, commit: checkoutCommit(root) };
}

function executable(path: string | undefined): path is string {
  if (!path) return false;
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}

export function linkedNode(): string | undefined {
  if (executable(process.env.BARRY_NODE)) return process.env.BARRY_NODE;
  const management = managedServices();
  for (const name of management.names()) {
    const definition = management.definition(name), node = definition.environment?.BARRY_NODE;
    if (definition.domain !== "system" && !definition.user && executable(node)) return node;
  }
  // A rollback to the link can stop before the link's setup rewrites the definitions; its receipt names the Node.
  try {
    const target = resolve(dirname(barryCurrentDir()), readlinkSync(barryCurrentDir()));
    for (const receipt of readReceipts()) for (const installation of [receipt.to, receipt.from]) {
      if (installation.kind === "link" && installation.target === target && executable(installation.node)) return installation.node;
    }
  } catch { /* no linked current or no readable receipts */ }
  return undefined;
}

export function installationPath(installation: Installation): string {
  return installation.kind === "release" ? join(barryReleasesDir(), installation.version) : installation.target;
}
export function installationExists(installation: Installation): boolean {
  const path = installationPath(installation);
  if (!existsSync(path)) return false;
  if (installation.kind === "release") return readRelease(path)?.commit === installation.commit;
  return existsSync(join(path, "identity.yaml")) && executable(join(path, "bin/barry")) && executable(installation.node);
}

export function pruneReleases(): string[] {
  const lines: string[] = [], current = currentInstallation(), previous = readReceipts()[0]?.from;
  const keep = new Set([current.target && resolve(current.target), previous && resolve(installationPath(previous))]);
  if (!existsSync(barryReleasesDir())) return lines;
  for (const entry of readdirSync(barryReleasesDir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "upgrades") continue;
    const path = join(barryReleasesDir(), entry.name);
    if (keep.has(resolve(path))) continue;
    try {
      const release = readRelease(path);
      if (!release && !/^\.\d+\.\d+\.\d+.*-/.test(entry.name)) continue;
      const bytes = releaseBytes(path);
      rmSync(path, { recursive: true });
      lines.push(`removed release ${release?.version ?? entry.name} (${bytes} bytes)`);
    } catch (error) { lines.push(`could not remove release ${entry.name}: ${String(error)}`); }
  }
  return lines;
}

/** Count copied content without following a release's symlinks. */
export function releaseBytes(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce((bytes, entry) => {
    const path = join(directory, entry.name);
    return bytes + (entry.isDirectory() ? releaseBytes(path) : lstatSync(path).size);
  }, 0);
}
