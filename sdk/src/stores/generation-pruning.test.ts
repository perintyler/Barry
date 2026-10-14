import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { activateStoreGeneration, acquireStoreGenerationLock } from "./generation-activation.js";
import { pruneStoreGenerations } from "./generation-pruning.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "barry-generation-pruning-")); roots.push(root);
  mkdirSync(join(root, "preparations")); mkdirSync(join(root, "generations"));
  candidate(root, "g0"); writeFileSync(join(root, "active.json"), JSON.stringify({ id: "g0" }));
  return root;
}
function candidate(root: string, id: string, state = "prepared") {
  mkdirSync(join(root, "generations", id));
  writeFileSync(join(root, "generations", id, "bytes"), "generation bytes");
  writeFileSync(join(root, "preparations", `${id}.json`), JSON.stringify({ root, id, state }));
}
async function chain(root: string) {
  for (let n = 1; n <= 3; n++) {
    candidate(root, `g${n}`);
    await activateStoreGeneration({ root, id: `g${n}`, previousId: `g${n - 1}`, servicesStopped: true, validate: async () => {}, sealPrevious: async () => {} });
  }
}
it("keeps active, previous and newer pending generations, removes abandoned trees and retains activation history", async () => {
  const root = fixture(); await chain(root);
  candidate(root, "rolledBack");
  await expect(activateStoreGeneration({ root, id: "rolledBack", previousId: "g3", servicesStopped: true, rollbackOnFailure: true,
    validate: async () => { throw Error("bad candidate"); }, sealPrevious: async () => {},
  })).rejects.toThrow("bad candidate");
  for (const state of ["failed", "preparing"]) candidate(root, state, state);
  candidate(root, ".pruning-x"); candidate(root, "pending"); candidate(root, "oldPending");
  const future = new Date(Date.now() + 10000);
  utimesSync(join(root, "preparations/pending.json"), future, future);
  utimesSync(join(root, "preparations/oldPending.json"), new Date(0), new Date(0));
  mkdirSync(join(root, "generations/.hidden"));
  symlinkSync(join(root, "generations/g3"), join(root, "generations/link"));
  writeFileSync(join(root, "generations/file"), "leave alone");
  writeFileSync(join(root, "preparations/orphan.json"), "{}");
  const before = readdirSync(join(root, "generations")), receipts = readdirSync(join(root, "activations"));
  const preview = await pruneStoreGenerations(root, { dryRun: true });
  expect(preview.kept).toEqual([{ id: "g3", reason: "active" }, { id: "g2", reason: "previous" }, { id: "pending", reason: "pending" }]);
  expect(preview.removed.map(entry => entry.id)).toEqual([".pruning-x", "failed", "g0", "g1", "oldPending", "preparing", "rolledBack"]);
  expect(preview.removed.every(entry => entry.bytes === 16)).toBe(true);
  expect(readdirSync(join(root, "generations"))).toEqual(before);
  expect(existsSync(join(root, "preparations/orphan.json"))).toBe(true);
  expect(await pruneStoreGenerations(root)).toEqual(preview);
  for (const { id } of preview.removed) expect(existsSync(join(root, "preparations", `${id}.json`))).toBe(false);
  expect(existsSync(join(root, "preparations/orphan.json"))).toBe(false);
  expect(readdirSync(join(root, "activations"))).toEqual(receipts);
  expect((await pruneStoreGenerations(root)).removed).toEqual([]);
});
it("refuses an occupied lock or an interrupted activation without removing anything", async () => {
  const root = fixture(); candidate(root, "g1");
  const before = readdirSync(join(root, "generations")), release = acquireStoreGenerationLock(root);
  try { await expect(pruneStoreGenerations(root)).rejects.toThrow(/Another Barry process/); }
  finally { release(); }
  await expect(activateStoreGeneration({ root, id: "g1", previousId: "g0", servicesStopped: true,
    validate: async () => {}, sealPrevious: async () => { throw Error("interrupted"); },
  })).rejects.toThrow("interrupted");
  const selector = readFileSync(join(root, "active.json"));
  await expect(pruneStoreGenerations(root)).rejects.toThrow(/barry db recover/);
  expect(readdirSync(join(root, "generations"))).toEqual(before);
  expect(readFileSync(join(root, "active.json"))).toEqual(selector);
});
it("keeps only the active generation of a legacy selector without receipts", async () => {
  const root = fixture(); candidate(root, "older", "failed");
  const result = await pruneStoreGenerations(root);
  expect(result.kept).toEqual([{ id: "g0", reason: "active" }]);
  expect(result.removed).toEqual([{ id: "older", bytes: 16 }]);
});
it("does not create stores or a lock without a selector", async () => {
  const root = join(fixture(), "missing");
  expect(await pruneStoreGenerations(root)).toEqual({ kept: [], removed: [] });
  expect(existsSync(root)).toBe(false);
});
