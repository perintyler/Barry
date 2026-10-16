import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdapters } from "./loader.js";
import { testAdapter } from "./testing.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("holds the real add/remove writer lock through synchronous selection publication against another Node process", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "adapter-selection-lock-")));roots.push(root);
  const directory = join(root, "adapter"), file = join(root, "adapters.json");mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@fixture/selection", version: "1.0.0", type: "module", exports: "./index.js", barry: { sessionAdapter: { contractVersion: 1 } } }));
  writeFileSync(join(directory, "index.js"), "// injected declaration fixture; never executed\n");
  const adapters = loadAdapters({ file, importModule: async () => ({ default: testAdapter({ aliases: ["former-id"] }) }) });
  const selected = await adapters.add(directory);
  const value = adapters.withSelection("former-id", record => {
    expect(record).toEqual(selected);
    const code = `import{loadAdapters}from ${JSON.stringify(new URL("../../../dist/adapters/internal.js", import.meta.url).href)};
try{loadAdapters({file:${JSON.stringify(file)}}).remove(${JSON.stringify(selected.id)});process.exitCode=42}
catch(error){if(!String(error.message).includes('session-adapters is in use'))throw error;process.exitCode=37}`;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
    expect(child.error).toBeUndefined();expect(child.status, child.stderr).toBe(37);
    expect(adapters.installed()).toEqual([selected]);return "published under lock";
  });
  expect(value).toBe("published under lock");expect(existsSync(join(root, "session-adapters.lock"))).toBe(false);
  expect(adapters.remove(selected.id)).toBe(true);
});

it("releases the shared writer lock when publication refuses and observes a later removed selection", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "adapter-selection-lock-")));roots.push(root);
  const adapters = loadAdapters({ file: join(root, "adapters.json") });
  expect(() => adapters.withSelection("missing", record => { expect(record).toBeUndefined();throw new Error("publication refused"); })).toThrow("publication refused");
  expect(existsSync(join(root, "session-adapters.lock"))).toBe(false);
  expect(adapters.withSelection("missing", record => record)).toBeUndefined();
});
