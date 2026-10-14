import { afterEach, beforeEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseManifestObject } from "../bags/manifest.js";
import { resolveLaunch } from "./launch.js";
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "launch contract ")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const base = { name: "demo", description: "demo" };
it("validates service/script metadata without resolving entry dependencies", () => {
  const manifest = parseManifestObject({ ...base, services: { api: { description: "api", entry: "src/service.ts" } }, scripts: { run: { description: "run", entry: "scripts/run.ts", args: [""] } } });
  expect(manifest.services.api.entry).toBe("src/service.ts");
  expect(manifest.scripts.run.entry).toBe("scripts/run.ts");
  expect(manifest.scripts.run.args).toEqual([""]);
});
it("requires exactly one launch form and confines entries to bag files", () => {
  for (const launch of [{}, { entry: "run.ts", command: "node" }, { entry: "../outside.ts" }, { entry: "/outside.ts" }, { entry: "run.sh" }]) {
    for (const kind of ["services", "scripts"]) {
      expect(() => parseManifestObject({ ...base, [kind]: { run: { description: "run", ...launch } } })).toThrow();
    }
  }
});
it("runs a JS entry from the bag root with literal argv even from another working directory", () => {
  writeFileSync(join(directory, "run.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));");
  const manifest = parseManifestObject({ ...base, scripts: { run: { description: "run", entry: "run.mjs", args: ["$(printf unexpected)", "", "two words"] } } });
  const launch = resolveLaunch(manifest.scripts.run, directory);
  const child = spawnSync(launch.command, launch.args, { cwd: tmpdir(), env: { PATH: "/missing" }, encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual(["$(printf unexpected)", "", "two words"]);
});
it("runs a TypeScript entry with its installed loader and an absolute Node interpreter", () => {
  mkdirSync(join(directory, "node_modules"));
  symlinkSync(resolve(import.meta.dirname, "../../node_modules/tsx"), join(directory, "node_modules", "tsx"), "dir");
  writeFileSync(join(directory, "run.ts"), "const value: number = 42; console.log(value);");
  const manifest = parseManifestObject({ ...base, scripts: { run: { description: "run", entry: "run.ts" } } });
  const launch = resolveLaunch(manifest.scripts.run, directory);
  const child = spawnSync(launch.command, launch.args, { cwd: tmpdir(), env: { PATH: "/missing" }, encoding: "utf8" });
  expect(child.status).toBe(0);
  expect(child.stdout.trim()).toBe("42");
});
