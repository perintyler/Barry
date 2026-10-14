import { constants } from "node:fs";
import { lstat, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { acquireStoreGenerationLock, previousStoreGeneration, requireStoreGenerationActive } from "./generation-activation.js";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).refine(id => !id.includes(".."));
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function readRecord(path: string, limit: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size > limit) throw new Error("invalid store generation record");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
async function treeBytes(path: string): Promise<number> {
  const file = await lstat(path);
  if (!file.isDirectory()) return file.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await treeBytes(join(path, name));
  return bytes;
}
async function entries(path: string): Promise<string[]> {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error("invalid store generation directory");
    return (await readdir(path)).sort();
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export async function pruneStoreGenerations(root: string, options: { dryRun?: boolean } = {}): Promise<{
  kept: { id: string; reason: "active" | "previous" | "pending" }[];
  removed: { id: string; bytes: number }[];
}> {
  const selector = join(root, "active.json");
  if (!await exists(selector)) return { kept: [], removed: [] };
  let release: () => void;
  try { release = acquireStoreGenerationLock(root); }
  catch (error) {
    if (error instanceof Error && error.message === "database is locked")
      throw new Error("Another Barry process is switching store generations; wait for it to finish.", { cause: error });
    throw error;
  }
  try {
    requireStoreGenerationActive(root);
    const active = z.object({ id: identifier }).parse(JSON.parse(await readRecord(selector, 16_384))).id;
    const kept: { id: string; reason: "active" | "previous" | "pending" }[] = [{ id: active, reason: "active" }];
    const previous = previousStoreGeneration(root);
    if (previous && previous.id !== active) kept.push({ id: previous.id, reason: "previous" });
    const selectedAt = (await lstat(selector)).mtimeMs, generations = join(root, "generations"), preparations = join(root, "preparations");
    const receipts = await entries(preparations);
    for (const name of receipts) {
      if (!name.endsWith(".json") || !identifier.safeParse(name.slice(0, -5)).success) continue;
      const id = name.slice(0, -5), path = join(preparations, name);
      if (kept.some(entry => entry.id === id) || await exists(join(root, "activations", name))) continue;
      if ((await lstat(path)).mtimeMs <= selectedAt || !await exists(join(generations, id))) continue;
      const receipt = JSON.parse(await readRecord(path, 64 * 1024 * 1024));
      if (receipt.state === "prepared" && receipt.id === id && receipt.root === root) kept.push({ id, reason: "pending" });
    }
    const removed: { id: string; bytes: number }[] = [];
    for (const id of await entries(generations)) {
      const path = join(generations, id);
      if (!(await lstat(path)).isDirectory() || id.startsWith(".") && !id.startsWith(".pruning-") || kept.some(entry => entry.id === id)) continue;
      removed.push({ id, bytes: await treeBytes(path) });
      if (options.dryRun) continue;
      const renamed = id.startsWith(".pruning-") ? path : join(generations, `.pruning-${id}`);
      if (renamed !== path) await rename(path, renamed);
      const handle = await open(generations, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      await rm(renamed, { recursive: true });
      await rm(join(preparations, `${id}.json`), { force: true });
    }
    if (!options.dryRun) for (const name of receipts) {
      if (name.endsWith(".json") && identifier.safeParse(name.slice(0, -5)).success && !await exists(join(generations, name.slice(0, -5))))
        await rm(join(preparations, name), { force: true });
    }
    return { kept, removed };
  } finally { release(); }
}
