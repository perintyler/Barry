/** Actual Node module-hook units with the exact copied production guard.
 * No retained-runtime launch, native eligibility or cessation claim is made. */
import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const roots: string[] = [];
const guardSource = fileURLToPath(new URL("./workflow-runtime-guard.mjs", import.meta.url));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function write(path: string, bytes: string | Buffer): void { mkdirSync(dirname(path), { recursive: true, mode: 0o700 });writeFileSync(path, bytes, { mode: 0o600 }); }
function fixture(extension = "mjs") {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "workflow-guard-unit-")));roots.push(outer);
  const root = join(outer, "installation/retained"), entry = join(root, "entry." + extension), tripwire = join(outer, "tripwire");mkdirSync(root, { recursive: true, mode: 0o700 });
  const files = new Set<string>(), guard = join(root, "guard.mjs");
  const add = (path: string, bytes: string | Buffer) => { write(join(root, path), bytes);files.add(path); };
  add("guard.mjs", readFileSync(guardSource));add("package.json", JSON.stringify({ name: "guard-unit", type: "module" }));
  const seal = (override: Record<string, unknown> = {}) => {
    const manifest = { version: 2, protocol: 1, platform: process.platform, arch: process.arch, nodeVersion: process.version,
      chunks: [...files].sort().map(path => { const bytes = readFileSync(join(root, path));return { digest: sha(bytes), bytes: bytes.length }; }),
      files: [...files].sort().map(path => { const bytes = readFileSync(join(root, path));return { path, content: { digest: sha(bytes), bytes: bytes.length }, storage: { chunk: sha(bytes), offset: 0 }, executable: false }; }), ...override };
    const bytes = Buffer.from(JSON.stringify(manifest));write(join(root, ".closure.json"), bytes);return sha(bytes);
  };
  return { outer, root, entry, tripwire, guard, add, seal, entryPath: "entry." + extension };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, identity: string, guarded = true): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [...(guarded ? ["--import", f.guard] : []), f.entry], {
      cwd: f.root, env: { PATH: "/usr/bin:/bin", BARRY_WORKFLOW_CLOSURE_SHA256: identity }, encoding: "utf8", timeout: 5000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as Error & { status?: number | null; signal?: string | null; stdout?: Buffer | string; stderr?: Buffer | string };
    // A native timeout/signal is a failed unit, never evidence of loader refusal.
    if (typeof failed.status !== "number" || failed.signal) throw error;
    return { status: failed.status, stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? "") };
  }
}
function refused(f: Fixture, identity: string, reason: string): void {
  const result = run(f, identity);expect(result.status, result.stderr).not.toBe(0);expect(result.stderr).toContain(reason);expect(existsSync(f.tripwire)).toBe(false);
}
function esmEffect(f: Fixture, result = "outside"): string { return `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(f.tripwire)},${JSON.stringify(result)});export default ${JSON.stringify(result)};`; }

it.each(["esm", "cjs", "createRequire"] as const)("denies actual ambient ancestor package fallback for %s before initialization, with an unguarded poison control", mode => {
  const f = fixture(mode === "cjs" ? "cjs" : "mjs"), packageRoot = join(f.outer, "installation/node_modules/ambient-poison");
  write(join(packageRoot, "package.json"), JSON.stringify({ name: "ambient-poison", version: "1.0.0", exports: "./index.cjs" }));
  write(join(packageRoot, "index.cjs"), `require('node:fs').writeFileSync(${JSON.stringify(f.tripwire)},'poison');module.exports='ambient poison';`);
  const source = mode === "esm" ? "import value from 'ambient-poison';process.stdout.write(value);"
    : mode === "cjs" ? "process.stdout.write(require('ambient-poison'));"
    : "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);process.stdout.write(require('ambient-poison'));";
  f.add(f.entryPath, source);const identity = f.seal();
  expect(readFileSync(f.guard)).toEqual(readFileSync(guardSource));
  const control = run(f, identity, false);expect(control.status, control.stderr).toBe(0);expect(control.stdout).toBe("ambient poison");expect(readFileSync(f.tripwire, "utf8")).toBe("poison");
  unlinkSync(f.tripwire);refused(f, identity, "WorkflowRuntimeExternalModuleForbidden");
});

it.each(["file-url", "symlink", "unlisted-private-tree-file"] as const)("denies an actual %s module outside the exact manifest before its side effect", mode => {
  const f = fixture(), outside = join(f.outer, "outside.mjs");write(outside, esmEffect(f));
  let target = pathToFileURL(outside).href;
  if (mode === "symlink") { symlinkSync(outside, join(f.root, "outside-alias.mjs"));target = "./outside-alias.mjs"; }
  if (mode === "unlisted-private-tree-file") { write(join(f.root, "not-in-manifest.mjs"), esmEffect(f));target = "./not-in-manifest.mjs"; }
  f.add(f.entryPath, `import value from ${JSON.stringify(target)};process.stdout.write(value);`);const identity = f.seal();
  const control = run(f, identity, false);expect(control.status, control.stderr).toBe(0);expect(existsSync(f.tripwire)).toBe(true);
  unlinkSync(f.tripwire);refused(f, identity, "WorkflowRuntimeExternalModuleForbidden");
});

it("evaluates actual verified ESM, CommonJS/createRequire and JSON bytes under the copied guard", () => {
  const f = fixture();
  f.add("verified.mjs", "export default 'verified-esm';");f.add("verified.cjs", "module.exports='verified-cjs';");f.add("config.json", '{"value":"verified-json"}');
  f.add(f.entryPath, "import esm from './verified.mjs';import json from './config.json' with {type:'json'};import {createRequire} from 'node:module';const require=createRequire(import.meta.url);process.stdout.write(JSON.stringify({esm,cjs:require('./verified.cjs'),json:json.value,cjsJson:require('./config.json').value,node:process.version}));");
  const result = run(f, f.seal());expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ esm: "verified-esm", cjs: "verified-cjs", json: "verified-json", cjsJson: "verified-json", node: process.version });
});

it.each(["mjs", "cjs"])("refuses same-length changed manifest-listed %s bytes before initialization", extension => {
  const f = fixture(), path = "changed." + extension;
  const original = extension === "mjs" ? esmEffect(f, "A") : `require('node:fs').writeFileSync(${JSON.stringify(f.tripwire)},'A');module.exports='A';`;
  f.add(path, original);f.add(f.entryPath, extension === "mjs" ? `import value from './${path}';process.stdout.write(value);` : `import {createRequire} from 'node:module';process.stdout.write(createRequire(import.meta.url)('./${path}'));`);
  const identity = f.seal(), replacement = original.replaceAll("'A'", "'B'").replaceAll('"A"', '"B"');expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
  write(join(f.root, path), replacement);refused(f, identity, "WorkflowRuntimeModuleChanged");
});

it.each(["ts", "unknown"])("fails closed for manifest-listed %s format instead of evaluating it", extension => {
  const f = fixture(), path = "unsupported." + extension;
  f.add(path, extension === "ts" ? `import {writeFileSync} from 'node:fs';const value:string='typescript';writeFileSync(${JSON.stringify(f.tripwire)},value);export default value;` : esmEffect(f));
  f.add(f.entryPath, `import value from './${path}';process.stdout.write(value);`);
  const result = run(f, f.seal());expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toMatch(/WorkflowRuntimeModuleFormatUnsupported|ERR_UNKNOWN_FILE_EXTENSION/);expect(existsSync(f.tripwire)).toBe(false);
});

it("rejects a mismatching closure digest before any entry initialization", () => {
  const f = fixture();f.add(f.entryPath, esmEffect(f));f.seal();refused(f, "0".repeat(64), "WorkflowRuntimeIdentityMismatch");
});
it.each([{ version: 1 }, { nodeVersion: "v26.0.0-unit-mismatch" }, { platform: "unsupported-unit-platform" }, { arch: "unsupported-unit-arch" }, { protocol: 2 }])("rejects manifest ABI mismatch %j before entry initialization", override => {
  const f = fixture();f.add(f.entryPath, esmEffect(f));refused(f, f.seal(override), "WorkflowRuntimeABIUnavailable");
});


for (const packageType of ["absent", "commonjs"] as const) {
  it.each(["cjs", "createRequire"] as const)(`loads verified ordinary JavaScript in a ${packageType}-type package through %s`, mode => {
    const f = fixture(mode === "cjs" ? "cjs" : "mjs");
    f.add("dependency/package.json", JSON.stringify({ name: "ordinary-js", ...(packageType === "commonjs" ? { type: "commonjs" } : {}) }));
    f.add("dependency/core.js", "module.exports='verified-ordinary-js';");
    f.add(f.entryPath, mode === "cjs" ? "process.stdout.write(require('./dependency/core.js'));"
      : "import {createRequire} from 'node:module';process.stdout.write(createRequire(import.meta.url)('./dependency/core.js'));");
    const result = run(f, f.seal());expect(result.status, result.stderr).toBe(0);expect(result.stdout).toBe("verified-ordinary-js");
  });
  it(`refuses same-length changed ordinary JavaScript in a ${packageType}-type package before initialization`, () => {
    const f = fixture();
    f.add("dependency/package.json", JSON.stringify({ name: "ordinary-js", ...(packageType === "commonjs" ? { type: "commonjs" } : {}) }));
    const original = `require('node:fs').writeFileSync(${JSON.stringify(f.tripwire)},'A');module.exports='A';`;
    f.add("dependency/core.js", original);
    f.add(f.entryPath, "import {createRequire} from 'node:module';process.stdout.write(createRequire(import.meta.url)('./dependency/core.js'));");
    const identity = f.seal(), changed = original.replaceAll("'A'", "'B'");expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    write(join(f.root, "dependency/core.js"), changed);refused(f, identity, "WorkflowRuntimeModuleChanged");
  });
}
it.each(["ts", "unknown"])("fails closed for createRequire of retained %s even on the undefined-format loader path", extension => {
  const f = fixture();f.add("dependency/package.json", JSON.stringify({ name: "untyped-package" }));
  const source = `require('node:fs').writeFileSync(${JSON.stringify(f.tripwire)},'must-not-run');module.exports='unsupported';`;
  f.add("dependency/unsupported." + extension, source);
  f.add(f.entryPath, `import {createRequire} from 'node:module';process.stdout.write(createRequire(import.meta.url)('./dependency/unsupported.${extension}'));`);
  const result = run(f, f.seal());expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toContain("WorkflowRuntimeModuleFormatUnsupported");expect(existsSync(f.tripwire)).toBe(false);
});
