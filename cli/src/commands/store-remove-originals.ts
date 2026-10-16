import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { barryAppSupportDir, barryArchivesDir, barryStoresDir } from "@barry-rocks/sdk/services";
import { activeStoreRoot } from "@barry-rocks/sdk/internal/stores";
import { identityStorePaths, storePath } from "@barry-rocks/sdk/stores";

import { errorMessage } from "../lib/error-message.js";
import { currentTarget } from "../target.js";

interface Original { path: string; archive: string; checksum: string }
interface Report { id: string; state: string; originals: Original[] }
interface FileIdentity { dev: number; ino: number; size: number }
interface OriginalState { verdict: "remove" | "keep" | "gone"; reason?: string; bytes: number; checkedFile?: FileIdentity }
interface OriginalVerdict extends Original, OriginalState { archiveTime?: number }
const companions = ["-wal", "-shm", "-journal"];

function fileStat(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function readReport(path: string): Report {
  const fd = openSync(path, "r"), buffer = Buffer.alloc(1024 ** 2);
  let head: string;
  try { head = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8"); }
  finally { closeSync(fd); }
  // Migration reports put the potentially enormous archived rows after this head.
  const marker = head.indexOf('\n  "tables": ');
  const report: unknown = JSON.parse(marker < 0 ? readFileSync(path, "utf8") : head.slice(0, marker).replace(/,\s*$/, "") + "\n}");
  if (!report || typeof report !== "object" || !("id" in report) || typeof report.id !== "string" ||
    !("state" in report) || typeof report.state !== "string" || !("originals" in report) || !Array.isArray(report.originals) ||
    !report.originals.every((entry: unknown) => entry && typeof entry === "object" &&
      "path" in entry && typeof entry.path === "string" && "archive" in entry && typeof entry.archive === "string" &&
      "checksum" in entry && typeof entry.checksum === "string")) throw new Error(`Invalid store migration report: ${path}`);
  return report as Report;
}

function checksum(path: string): string {
  const hash = createHash("sha256"), buffer = Buffer.alloc(1024 ** 2), fd = openSync(path, "r");
  try { let bytes: number; while ((bytes = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes)); }
  finally { closeSync(fd); }
  return hash.digest("hex");
}

function hasDataParent(path: string): boolean {
  const parent = dirname(path);
  return !existsSync(parent) || relative(realpathSync(barryAppSupportDir()), realpathSync(parent)) === relative(barryAppSupportDir(), parent);
}

function presentCompanions(path: string): { path: string; stat: Stats }[] {
  return companions.flatMap(suffix => {
    const stat = fileStat(path + suffix);
    return stat ? [{ path: path + suffix, stat }] : [];
  });
}

function leftBehind(path: string): string {
  const left = presentCompanions(path).map(file => displayPath(file.path));
  return left.length ? ` (left behind: ${left.join(", ")})` : "";
}

// `checkedFile` is the main file as its verdict saw it: a file swapped in during the
// prompt can carry an older mtime (a restored copy keeps its own), so match it too.
function originalState(path: string, archiveTime: number, checkedFile?: FileIdentity): OriginalState {
  const main = fileStat(path);
  if (!main) return { verdict: "gone", bytes: 0, reason: `already gone${leftBehind(path)}` };
  if (!main.isFile()) return { verdict: "keep", bytes: 0, reason: "not a regular file" };
  const files = [{ path, stat: main }, ...presentCompanions(path)];
  const bytes = files.reduce((sum, file) => sum + file.stat.size, 0);
  const newest = files.filter(file => !file.path.endsWith("-shm") && file.stat.mtimeMs > archiveTime)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
  if (newest) return { verdict: "keep", bytes, reason: `written since the migration: ${displayPath(newest.path)} at ${newest.stat.mtime.toISOString()}` };
  if (checkedFile && (main.dev !== checkedFile.dev || main.ino !== checkedFile.ino)) return { verdict: "keep", bytes, reason: "replaced since it was checked" };
  if (checkedFile && main.size !== checkedFile.size) return { verdict: "keep", bytes, reason: `changed size since it was checked (${checkedFile.size} to ${main.size} bytes)` };
  return { verdict: "remove", bytes, checkedFile: { dev: main.dev, ino: main.ino, size: main.size } };
}

// Removes the main file first, so a reader that opens the path finds nothing rather
// than a main file without its WAL. Returns the companions that are still there.
function removeOriginal(path: string, bytes: number): { freed: number; left: string[] } {
  unlinkSync(path);
  let freed = bytes;
  const left: string[] = [];
  for (const suffix of companions) {
    const companion = path + suffix, stat = fileStat(companion);
    if (!stat) continue;
    if (!stat.isFile() && !stat.isSymbolicLink()) { left.push(`${displayPath(companion)} (not a regular file)`); continue; }
    // SQLite deletes its -wal when the last connection closes, which can fall between the lstat and here.
    try { unlinkSync(companion); freed += stat.size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") left.push(`${displayPath(companion)} (${errorMessage(error)})`); }
  }
  return { freed, left };
}

export function originalVerdicts(reportPath: string): { report: Report; root: string; originals: OriginalVerdict[] } {
  if (currentTarget().kind === "identity") throw new Error("Run barry store remove-originals from the instance, not through an identity command.");
  const report = readReport(reportPath);
  if (report.state !== "active") throw new Error(`Store migration ${report.id} never activated (state: ${report.state}): its originals are still this home's only copy of those stores.`);
  if (!existsSync(join(barryStoresDir(), "active.json"))) throw new Error("This home has no active store generation, so its originals are its stores.");
  const root = activeStoreRoot();
  console.log("Checking archived copies against the migration report...");
  const archivePaths = new Set(report.originals.flatMap(original => [resolve(original.archive), resolve(dirname(reportPath), basename(original.archive))]));
  const originals = report.originals.map((original): OriginalVerdict => {
    const parts = relative(barryAppSupportDir(), original.path).split("/");
    const segment = /^[a-z0-9][a-z0-9._-]*$/i;
    const bag = parts[1], store = parts[2]?.slice(0, -3);
    const keep = (reason: string, bytes = 0): OriginalVerdict => ({ ...original, verdict: "keep", reason, bytes });
    if (!isAbsolute(original.path) || parts.length !== 3 || parts[0] !== "data" || !segment.test(bag) ||
      !parts[2].endsWith(".db") || !segment.test(store) || bag.includes("..") || store.includes("..")) return keep("not under data/");
    if (!hasDataParent(original.path))
      return keep("not under data/");
    const state = originalState(original.path, Infinity);
    if (state.verdict !== "remove") return { ...original, ...state };
    if (!existsSync(storePath({ node: "local", bag, store }, "node", root)) && !identityStorePaths(bag, store).length)
      return keep("not in the active generation", state.bytes);
    const archive = existsSync(original.archive) ? original.archive : join(dirname(reportPath), basename(original.archive));
    const inArchiveFolder = relative(resolve(dirname(reportPath)), resolve(original.path));
    if ([original.path, ...companions.map(suffix => original.path + suffix)].some(path => archivePaths.has(resolve(path))) || (!inArchiveFolder.startsWith("../") && inArchiveFolder !== ".." && !isAbsolute(inArchiveFolder)))
      return keep("is an archived copy or in the report folder", state.bytes);
    const archived = fileStat(archive);
    if (!archived?.isFile()) return keep("archived copy missing", state.bytes);
    if (checksum(archive) !== original.checksum) return keep("archived copy does not match the report", state.bytes);
    // VACUUM INTO creates the copy before it starts reading, so a write while the copy
    // was still being filled is in the original only: measure from the copy's creation.
    const migrated = archived.birthtimeMs > 0 ? Math.min(archived.birthtimeMs, archived.mtimeMs) : archived.mtimeMs;
    return { ...original, ...originalState(original.path, migrated), archiveTime: migrated };
  });
  return { report, root, originals };
}

function displayPath(path: string): string {
  const local = relative(barryAppSupportDir(), path);
  return local === ".." || local.startsWith("../") || isAbsolute(local) ? path : local;
}
function size(bytes: number): string { return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
function folderSize(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((bytes, entry) => {
    const child = join(path, entry.name);
    return bytes + (entry.isDirectory() ? folderSize(child) : lstatSync(child).size);
  }, 0);
}

export async function storeRemoveOriginalsCommand(options: {
  report?: string; dryRun?: boolean; yes?: boolean; confirm?(message: string): Promise<boolean>;
} = {}): Promise<void> {
  if (currentTarget().kind === "identity") throw new Error("Run barry store remove-originals from the instance, not through an identity command.");
  const directory = join(barryArchivesDir(), "store-migrations");
  let reportPath = options.report ? resolve(options.report) : undefined;
  if (!reportPath) {
    const reports = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => join(directory, entry.name, "report.json")).filter(path => existsSync(path)) : [];
    if (!reports.length) { console.log(`No store migration report under ${directory}; nothing to remove. Pass --report <path> if the archive was moved.`); return; }
    if (reports.length > 1) throw new Error(`More than one store migration report; pass --report <path>:\n${reports.join("\n")}`);
    reportPath = reports[0];
  }
  const { report, root, originals } = originalVerdicts(reportPath), folder = dirname(reportPath);
  const removable = originals.filter(original => original.verdict === "remove"), kept = originals.filter(original => original.verdict === "keep"), gone = originals.filter(original => original.verdict === "gone");
  const bytes = removable.reduce((sum, original) => sum + original.bytes, 0);
  console.log(`Store migration ${report.id}, report ${displayPath(reportPath)}`);
  console.log(`Active generation: ${basename(root)}`);
  console.log(`Remove (${removable.length} originals, ${size(bytes)}):`);
  for (const original of removable) console.log(`  ${displayPath(original.path)} (${size(original.bytes)})`);
  console.log(`Keep (${kept.length}):`);
  for (const original of kept) console.log(`  ${displayPath(original.path)}: ${original.reason}`);
  if (gone.length) { console.log("Already gone:"); for (const original of gone) console.log(`  ${displayPath(original.path)}${leftBehind(original.path)}`); }
  console.log(`The archived copies and report.json stay in ${folder} (${size(folderSize(folder))}).`);
  if (!removable.length) { console.log("Nothing to remove."); return; }
  if (options.dryRun) return;
  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Unattended removal requires --yes");
    const message = `Remove ${removable.length} pre-migration originals (${size(bytes)}) from ${barryAppSupportDir()}/data? Their archived copies stay in ${folder}.`;
    const confirmed = options.confirm ? await options.confirm(message) : await (await import("@inquirer/prompts")).confirm({ message, default: false });
    if (!confirmed) { console.log("No changes made."); return; }
  }
  let removed = 0, freed = 0;
  const incomplete: string[] = [];
  for (const original of removable) {
    if (!hasDataParent(original.path)) { console.log(`  Kept ${displayPath(original.path)}: not under data/`); continue; }
    const state = originalState(original.path, original.archiveTime!, original.checkedFile);
    if (state.verdict !== "remove") { console.log(`  Kept ${displayPath(original.path)}: ${state.reason}`); continue; }
    let removal: ReturnType<typeof removeOriginal>;
    try { removal = removeOriginal(original.path, state.checkedFile!.size); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { console.log(`  Kept ${displayPath(original.path)}: already gone${leftBehind(original.path)}`); continue; }
      console.log(`  Could not remove ${displayPath(original.path)}: ${errorMessage(error)}`);
      incomplete.push(`${displayPath(original.path)} (${errorMessage(error)})`);
      continue;
    }
    removed++; freed += removal.freed;
    if (removal.left.length) { console.log(`  Removed ${displayPath(original.path)} but not ${removal.left.join(", ")}`); incomplete.push(...removal.left); }
  }
  console.log(`Removed ${removed} originals and freed ${size(freed)}.`);
  // Every original was still attempted; the failure says what is left for the operator.
  if (incomplete.length) throw new Error(`Removal incomplete; these are still there:\n${incomplete.join("\n")}`);
}
