import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { activateStoreGeneration, recoverStoreGeneration, prepareStoreGeneration, validatePreparedStoreGeneration, activeStoreRoot } from "@barry-rocks/sdk/internal/stores";

import { directory, sourceHome, serviceFixture } from "./__tests__/db-home.js";
import { dbRecoverCommand } from "./db-recover.js";
import { dbPruneCommand } from "./db-prune.js";
import { dbRestoreCommand } from "./db-restore.js";
import { dbRollbackCommand } from "./db-rollback.js";
import { dbBackupCommand } from "./db.js";

async function interruptedHome(boundary = "sealing") {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { root } = await sourceHome();
  const candidate = await prepareStoreGeneration({ root, previousId: "g1", servicesStopped: true });
  let validations = 0;
  const activation = activateStoreGeneration({ root, id: candidate.id, previousId: "g1", servicesStopped: true,
    validate: async () => {
      validations++;
      await validatePreparedStoreGeneration(root, candidate.id);
      if (boundary === "selector" && validations === 3) writeFileSync(join(root, "activations"), "block receipt directory");
      if (boundary === "prepared" && validations === 2 || boundary === "sealed" && validations === 3) throw Error("interrupted validation");
    },
    sealPrevious: async () => { if (boundary === "sealing") throw Error("interrupted seal"); },
  });
  if (boundary === "receipt") {
    const receipt = await activation;
    writeFileSync(join(root, "activation.json"), JSON.stringify({ ...receipt, state: "sealed" }));
  } else await expect(activation).rejects.toThrow();
  if (boundary === "selector") {
    expect(JSON.parse(readFileSync(join(root, "active.json"), "utf8")).id).toBe(candidate.id);
    rmSync(join(root, "activations"));
  }
  return { root, candidate, log };
}
it.each(["prepared", "sealing", "sealed", "selector", "receipt"])("finishes at %s and restarts exactly the running user services", async boundary => {
  const { root, candidate, log } = await interruptedHome(boundary), control = serviceFixture();
  await dbRecoverCommand({ services: control.services });
  expect(log.mock.calls.flat().join("\n")).not.toContain("Could not finish");
  expect(activeStoreRoot()).toBe(candidate.directory);
  expect(control.stopped).toEqual(["sessions.api", "mcp.server"]);
  expect(control.started).toEqual(control.stopped);
  expect(control.roots).toEqual([candidate.directory, candidate.directory]);
  expect(control.states.get("vault.api")).toBe(true);
  expect(existsSync(join(root, "generations/g1"))).toBe(true);
  expect(log.mock.calls.flat().join("\n")).toContain(`Finished: generation ${candidate.id} is active`);
  await dbRecoverCommand({ services: control.services });
  expect(control.stopped).toHaveLength(2);
  expect(log.mock.calls.flat().join("\n")).toContain("No store switch was interrupted; nothing to recover.");
});
it("rolls back a changed candidate and restarts services on the previous generation", async () => {
  const { root, candidate, log } = await interruptedHome(), control = serviceFixture();
  writeFileSync(join(candidate.directory, "changed"), "invalid");
  const before = readFileSync(join(root, "active.json"));
  await dbRecoverCommand({ services: control.services });
  expect(readFileSync(join(root, "active.json"))).toEqual(before);
  expect(control.roots).toEqual([join(root, "generations/g1"), join(root, "generations/g1")]);
  expect(control.started).toEqual(control.stopped);
  expect(log.mock.calls.flat().join("\n")).toContain("Could not finish (prepared store generation changed): generation g1 stays active.");
});
it("refuses an occupied lock before stopping any services", async () => {
  const { root } = await interruptedHome(), control = serviceFixture(), lock = new DatabaseSync(join(root, "activation.db"));
  lock.exec("BEGIN IMMEDIATE");
  try { await expect(dbRecoverCommand({ services: control.services })).rejects.toThrow(/Another Barry process/); }
  finally { lock.exec("ROLLBACK"); lock.close(); }
  expect(control.stopped).toEqual([]);
});
it("other db commands refuse interrupted activations with the recovery hint before stopping services", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { root } = await sourceHome(), backup = join(directory("barry-interrupted-backup-"), "backup");
  await dbBackupCommand(backup, { vault: false });
  const candidate = await prepareStoreGeneration({ root, previousId: "g1", servicesStopped: true });
  await expect(activateStoreGeneration({ root, id: candidate.id, previousId: "g1", servicesStopped: true,
    validate: async () => {}, sealPrevious: async () => { throw Error("interrupted"); },
  })).rejects.toThrow("interrupted");
  const control = serviceFixture();
  await expect(dbBackupCommand(join(directory("barry-refused-backup-"), "backup"), { vault: false })).rejects.toThrow(/barry db recover/);
  await expect(dbRestoreCommand(backup, { services: control.services })).rejects.toThrow(/barry db recover/);
  await expect(dbRollbackCommand({ yes: true, services: control.services })).rejects.toThrow(/barry db recover/);
  await expect(dbPruneCommand({ yes: true })).rejects.toThrow(/barry db recover/);
  expect(control.stopped).toEqual([]);
});

it("validates the interrupted candidate found after services stop when another terminal changed the journal", async () => {
  const { root, candidate, log } = await interruptedHome(), control = serviceFixture();
  const stop = control.services.stop;
  let nextId: string | undefined;
  control.services.stop = async key => {
    await stop(key);
    if (key !== "mcp.server") return;
    await recoverStoreGeneration({ root, servicesStopped: true,
      validate: async () => { await validatePreparedStoreGeneration(root, candidate.id); },
    });
    const next = await prepareStoreGeneration({ root, previousId: candidate.id, servicesStopped: true });
    nextId = next.id;
    await expect(activateStoreGeneration({ root, id: next.id, previousId: candidate.id, servicesStopped: true,
      validate: async () => { await validatePreparedStoreGeneration(root, next.id); },
      sealPrevious: async () => { throw Error("another interrupted switch"); },
    })).rejects.toThrow("another interrupted switch");
    writeFileSync(join(next.directory, "changed"), "invalid");
  };
  await dbRecoverCommand({ services: control.services });
  expect(activeStoreRoot()).toBe(candidate.directory);
  expect(control.roots).toEqual([candidate.directory, candidate.directory]);
  expect(control.started).toEqual(control.stopped);
  expect(JSON.parse(readFileSync(join(root, "activations", `${nextId}.json`), "utf8")).state).toBe("rolledBack");
  expect(log.mock.calls.flat().join("\n")).toContain(`Could not finish (prepared store generation changed): generation ${candidate.id} stays active.`);
});
