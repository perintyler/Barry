import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";

it("closes the cached vault before releasing ownership and refuses reopening through a maintenance fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "vd-")), path = join(root, "vault.db");
  vi.stubEnv("VAULT_DB_PATH", path); vi.resetModules();
  const { getDb, closeDb } = await import("./db.js");
  try {
    const vault = getDb(), contender = new Database(`${path}.owner-lock`, { timeout: 0 });
    try {
      expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      writeFileSync(`${path}.maintenance`, "operation pending");
      const close = vi.spyOn(vault, "close").mockImplementationOnce(() => { throw new Error("close refused"); });
      expect(() => closeDb()).toThrow("close refused");
      expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
      close.mockRestore();
      closeDb(); expect(vault.open).toBe(false);
      contender.exec("BEGIN IMMEDIATE"); contender.exec("ROLLBACK");
      expect(() => getDb()).toThrow(/maintenance is active/);
    } finally { contender.close(); }
  } finally { closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
