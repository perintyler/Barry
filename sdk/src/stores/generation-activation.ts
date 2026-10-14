import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const generationId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i).refine(id => !id.includes(".."));
const journalSchema = z.strictObject({
  format: z.literal(1), root: z.string(), id: generationId, previousId: generationId,
  state: z.enum(["prepared", "sealing", "sealed", "active", "rolledBack"]),
  previousChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  nextChecksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export type StoreGenerationActivation = z.infer<typeof journalSchema>;
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function readRegular(path: string): string {
  const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = fstatSync(handle);
    if (!file.isFile() || file.size > 16_384) throw new Error("invalid generation activation record");
    return readFileSync(handle, "utf8");
  } finally { closeSync(handle); }
}
function readJournal(root: string): StoreGenerationActivation | undefined {
  try {
    const journal = journalSchema.parse(JSON.parse(readRegular(join(root, "activation.json"))));
    if (journal.root !== root) throw new Error("generation activation belongs to another root");
    return journal;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
function requireDirectory(path: string): void {
  const file = lstatSync(path);
  if (!file.isDirectory() || file.isSymbolicLink()) throw new Error("invalid generation directory");
}
function syncDirectory(root: string): void {
  const handle = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(handle); } finally { closeSync(handle); }
}
function publish(root: string, filename: string, bytes: string): void {
  const temporary = join(root, `.activation-${randomUUID()}`);
  const handle = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(handle, bytes); fsyncSync(handle); } finally { closeSync(handle); }
  renameSync(temporary, join(root, filename));
  syncDirectory(root);
}
function recoveryHint(journal: StoreGenerationActivation): string {
  return `store generation activation ${journal.id} requires recovery: the switch from ${journal.previousId} stopped at ${journal.state}. Run \`barry db recover\`.`;
}
class StoreGenerationLockError extends Error {}
function switchingError(error: unknown): unknown {
  return error instanceof StoreGenerationLockError
    ? new Error("Another Barry process is switching store generations; wait for it to finish.", { cause: error }) : error;
}
export function interruptedStoreGeneration(root: string): { id: string; previousId: string; state: "prepared" | "sealing" | "sealed" } | undefined {
  const journal = readJournal(root);
  if (!journal || journal.state === "active" || journal.state === "rolledBack") return;
  let release: () => void;
  try { release = acquireStoreGenerationLock(root); } catch (error) { throw switchingError(error); }
  try {
    const current = readJournal(root);
    if (!current || current.state === "active" || current.state === "rolledBack") return;
    return { id: current.id, previousId: current.previousId, state: current.state };
  } finally { release(); }
}

/** Finish an interrupted switch using only a no-op seal of the previous generation. */
export async function recoverStoreGeneration(options: {
  root: string; servicesStopped: boolean; validate(directory: string): Promise<void>;
}): Promise<{ id: string; previousId: string; state: "active" | "rolledBack"; reason?: string } | undefined> {
  const interrupted = interruptedStoreGeneration(options.root);
  if (!interrupted) return;
  const { id, previousId } = interrupted, { root } = options;
  try {
    await activateStoreGeneration({ ...options, id, previousId, rollbackOnFailure: true, sealPrevious: async () => {} });
    return { id, previousId, state: "active" };
  } catch (error) {
    const translated = switchingError(error);
    if (translated !== error) throw translated;
    const reason = error instanceof Error ? error.message : String(error);
    if (JSON.parse(readRegular(join(root, "active.json"))).id === id)
      throw new Error(`Cannot recover the switch to ${id}: it is already selected, but ${reason}. Nothing was changed.`, { cause: error });
    const receipt = join(root, "activations", `${id}.json`);
    if (pathExists(receipt)) {
      const outcome = journalSchema.parse(JSON.parse(readRegular(receipt)));
      if (outcome.root === root && outcome.id === id && outcome.previousId === previousId && outcome.state === "rolledBack")
        return { id, previousId, state: "rolledBack", reason };
    }
    throw error;
  }
}
export function requireStoreGenerationActive(root: string): void {
  const journal = readJournal(root);
  if (journal && journal.state !== "active" && journal.state !== "rolledBack") throw new Error(recoveryHint(journal));
}
export function previousStoreGeneration(root: string): { id: string; replacedBy: string; replacedAt: Date } | undefined {
  requireStoreGenerationActive(root);
  const selector = join(root, "active.json");
  if (!pathExists(selector)) return;
  const { id } = z.object({ id: generationId }).parse(JSON.parse(readRegular(selector)));
  const receipts = join(root, "activations"), receipt = join(receipts, `${id}.json`);
  if (!pathExists(receipts)) return;
  requireDirectory(receipts);
  if (!pathExists(receipt)) return;
  const activation = journalSchema.parse(JSON.parse(readRegular(receipt)));
  if (activation.id !== id || activation.root !== root || activation.state !== "active") throw new Error("invalid previous generation activation receipt");
  requireDirectory(join(root, "generations"));
  requireDirectory(join(root, "generations", activation.previousId));
  return { id: activation.previousId, replacedBy: id, replacedAt: lstatSync(receipt).mtime };
}
export function acquireStoreGenerationLock(root: string): () => void {
  requireDirectory(root);
  // This operator lock is outside the generation store catalog and has no bag
  // writer or registry provider; every opener of this file uses node:sqlite.
  const path = join(root, "activation.db");
  try {
    const handle = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    closeSync(handle); syncDirectory(root);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error("invalid generation operator lock");
  const database = new DatabaseSync(path);
  try { database.exec("PRAGMA busy_timeout=100; BEGIN IMMEDIATE"); }
  catch (error) {
    database.close();
    if (error instanceof Error && error.message === "database is locked") throw new StoreGenerationLockError(error.message, { cause: error });
    throw error;
  }
  return () => { try { database.exec("ROLLBACK"); } finally { database.close(); } };
}

export async function activateStoreGeneration(options: {
  root: string; id: string; previousId: string; servicesStopped: boolean;
  /** For cutovers that leave the outgoing generation writable (no sealing mutations). */
  rollbackOnFailure?: boolean;
  validate(directory: string): Promise<void>;
  sealPrevious(directory: string): Promise<void>;
}): Promise<StoreGenerationActivation> {
  const { root, id, previousId } = options;
  generationId.parse(id); generationId.parse(previousId);
  if (!options.servicesStopped) throw new Error("stop and drain affected services before activating stores");
  if (!isAbsolute(root) || id === previousId) throw new Error("invalid generation activation mapping");
  requireDirectory(root); requireDirectory(join(root, "generations"));
  const candidate = join(root, "generations", id), previous = join(root, "generations", previousId);
  requireDirectory(candidate); requireDirectory(previous);
  const release = acquireStoreGenerationLock(root);
  let originalSelector: string | undefined;
  try {
    originalSelector = readRegular(join(root, "active.json"));
    const markerPath = join(root, "active.json"), nextMarker = JSON.stringify({ id });
    let journal = readJournal(root);
    const selected = readRegular(markerPath);
    const selection = z.object({ id: generationId }).parse(JSON.parse(selected));
    if (journal?.state === "active" && journal.id === id && journal.previousId === previousId) {
      if (digest(selected) !== journal.nextChecksum) throw new Error("active generation selector changed");
      await options.validate(candidate);
      requireDirectory(join(root, "activations"));
      if (readRegular(join(root, "activations", `${id}.json`)) !== JSON.stringify(journal)) throw new Error("generation activation receipt changed");
      return Object.freeze(journal);
    }
    if (journal && journal.state !== "active" && journal.state !== "rolledBack") {
      if (journal.id !== id || journal.previousId !== previousId || journal.nextChecksum !== digest(nextMarker)) throw new Error(recoveryHint(journal));
      if (digest(selected) !== journal.previousChecksum && !(journal.state === "sealed" && digest(selected) === journal.nextChecksum))
        throw new Error("generation selector changed during activation");
    } else {
      if (selection.id !== previousId) throw new Error("outgoing generation no longer selected");
      const receipts = join(root, "activations");
      if (pathExists(receipts)) {
        requireDirectory(receipts);
        if (pathExists(join(receipts, `${id}.json`))) throw new Error("generation ID already activated");
      }
      // A writable cutover is first validated below, after the journal, so a failure leaves a rolledBack receipt.
      if (!options.rollbackOnFailure) await options.validate(candidate);
      if (readRegular(markerPath) !== selected) throw new Error("generation selector changed during preparation");
      journal = { format: 1, root, id, previousId, state: "prepared", previousChecksum: digest(selected), nextChecksum: digest(nextMarker) };
      publish(root, "activation.json", JSON.stringify(journal));
    }
    const save = (state: StoreGenerationActivation["state"]) => {
      journal = { ...journal!, state };
      publish(root, "activation.json", JSON.stringify(journal));
    };
    await options.validate(candidate);
    if (journal.state === "prepared") save("sealing");
    if (journal.state === "sealing") {
      if (digest(readRegular(markerPath)) !== journal.previousChecksum) throw new Error("generation selector changed before sealing");
      await options.sealPrevious(previous);
      save("sealed");
    }
    if (journal.state === "sealed") {
      await options.validate(candidate);
      const marker = readRegular(markerPath), checksum = digest(marker);
      if (checksum === journal.previousChecksum) publish(root, "active.json", nextMarker);
      else if (checksum !== journal.nextChecksum) throw new Error("generation selector changed before publication");
      const receipts = join(root, "activations");
      try { mkdirSync(receipts, { mode: 0o700 }); syncDirectory(root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      requireDirectory(receipts);
      const receipt = JSON.stringify({ ...journal, state: "active" });
      let existing: string | undefined;
      try { existing = readRegular(join(receipts, `${id}.json`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing !== undefined && existing !== receipt) throw new Error("generation activation receipt conflicts");
      if (existing === undefined) publish(receipts, `${id}.json`, receipt);
      save("active");
    }
    return Object.freeze(journal);
  } catch (error) {
    if (options.rollbackOnFailure && originalSelector !== undefined) {
      const journal = readJournal(root);
      if (journal?.id === id && journal.previousId === previousId && digest(originalSelector) === journal.previousChecksum) {
        const selected = readRegular(join(root, "active.json"));
        if (digest(selected) !== journal.previousChecksum && digest(selected) !== journal.nextChecksum) throw new Error("cannot recover changed generation selector", { cause: error });
        publish(root, "active.json", originalSelector);
        const outcome = JSON.stringify({ ...journal, state: "rolledBack" });
        mkdirSync(join(root, "activations"), { recursive: true, mode: 0o700 });
        publish(join(root, "activations"), `${id}.json`, outcome);
        publish(root, "activation.json", outcome);
      }
    }
    throw error;
  } finally {
    release();
  }
}

/** Seed the selector once; every subsequent change uses the activation journal. */
export function bootstrapStoreGeneration(root: string): string {
  if (!isAbsolute(root)) throw new Error("invalid store generation root");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const release = acquireStoreGenerationLock(root);
  try {
    requireStoreGenerationActive(root);
    const marker = join(root, "active.json");
    if (pathExists(marker)) return z.object({ id: generationId }).parse(JSON.parse(readRegular(marker))).id;
    const id = randomUUID();
    mkdirSync(join(root, "generations", id), { recursive: true, mode: 0o700 });
    syncDirectory(join(root, "generations"));
    publish(root, "active.json", JSON.stringify({ id }));
    return id;
  } finally { release(); }
}
