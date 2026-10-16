/** Real esbuild + Node loading only; no guardian/cessation or sandbox claim. */
import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOwnedProcessEntrypoint } from "./owned-process.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "owned-capture-loading-"));roots.push(root);
  const original = join(root, "original");mkdirSync(original);
  const entry = join(original, "entry.mjs"), captured = join(root, "captured.mjs");
  return { root, original, entry,
    run() {
      writeFileSync(captured, captureOwnedProcessEntrypoint(entry));
      rmSync(original, { recursive: true, force: true });
      return spawnSync(process.execPath, [captured], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
    },
  };
}

it("runs bundled CommonJS builtin imports and a static package after original package deletion", () => {
  const f = fixture(), dependency = join(f.original, "node_modules", "captured-dependency");mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "captured-dependency", version: "1.0.0", main: "index.cjs" }));
  writeFileSync(join(dependency, "index.cjs"), "module.exports={version:require('process').version,value:require('buffer').Buffer.from('retained').toString('hex')};");
  writeFileSync(f.entry, "import value from 'captured-dependency';console.log(JSON.stringify(value));");
  const result = f.run();expect(result.error).toBeUndefined();expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ version: process.version, value: Buffer.from("retained").toString("hex") });
});

it("preserves an entry's own lexical require binding without a generated-name collision", () => {
  const f = fixture();writeFileSync(f.entry, "#!/usr/bin/env node\nconst require=()=> 'local-binding';console.log(require());");
  const result = f.run();expect(result.error).toBeUndefined();expect(result.status, result.stderr).toBe(0);expect(result.stdout.trim()).toBe("local-binding");
});

it("refuses computed nonbuiltin loading before the ambient module initializer runs", () => {
  const f = fixture(), poison = join(f.root, "poison.cjs");
  writeFileSync(poison, "console.log('AMBIENT_INITIALIZED');module.exports='ambient';");
  writeFileSync(f.entry, `const name=JSON.parse(${JSON.stringify(JSON.stringify(poison))});require(name);`);
  const result = f.run();expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("OwnedProcessBuiltinRequireOnly");expect(result.stdout).not.toContain("AMBIENT_INITIALIZED");
});


it("runs a recaptured bootstrap with CommonJS builtins after both original generations are deleted", () => {
  const f = fixture(), dependency = join(f.original, "helper.cjs");
  writeFileSync(dependency, "module.exports=require('buffer').Buffer.from(require('process').version).toString('hex');");
  writeFileSync(f.entry, "import value from './helper.cjs';const require=()=> 'local-binding';console.log(JSON.stringify({value,local:require()}));");
  const first = join(f.root, "first.mjs"), second = join(f.root, "second.mjs");
  writeFileSync(first, captureOwnedProcessEntrypoint(f.entry));
  writeFileSync(second, captureOwnedProcessEntrypoint(first));
  rmSync(f.original, { recursive: true, force: true });rmSync(first);
  const result = spawnSync(process.execPath, [second], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
  expect(result.error).toBeUndefined();expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ value: Buffer.from(process.version).toString("hex"), local: "local-binding" });
});
