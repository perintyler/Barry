import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertOutputOutsideCheckout, assertPlatform, checkLinks, removeDevelopmentFiles, renderFormula, scanSecrets } from "./build.js";
import { checkImports } from "./probe.js";
import { releaseRoot } from "./release.js";
const roots: string[] = [];
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "barry-build-test-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(root: string, name: string, content = "fixture") { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path; }
it("removes development files while preserving SDK testing and dependency trees", () => {
  const root = fixture();
  const removed = [".github/a", ".changeset/config.json", "eslint.config.js", "tsconfig.eslint.json", "knip.ts", "knip.base.json", "vitest.base.config.ts", "static-gate.json", "cli/vitest.config.ts", "sdk/vitest.integration.ts", "cli/src/a.test.ts", "sdk/src/a.test.mts", "bags/x/a.test.js", "bags/x/a.test.mjs", "sdk/src/a.test-d.ts", "sdk/src/a.spec.ts", "cli/test/a", "sdk/__tests__/a", "bags/x/__fixtures__/a", "bags/x/__golden__/a", "bags/x/fixtures/a", "node_modules/.cache/a"];
  const kept = ["sdk/CHANGELOG.md", "sdk/src/testing/a.ts", "node_modules/pkg/a.test.ts", "runtime/fixtures/a", "bags/x/dist/a.js", "cli/src/a.ts", "bags/workflows/runtime/src/a.ts"];
  // A package folder named runtime is first-party; only the root's runtime/ is left alone.
  removed.push("bags/workflows/runtime/src/a.test.ts", "bags/workflows/runtime/vitest.config.ts", "bags/workflows/runtime/test/a");
  file(root, "cli/package.json", "{}");
  file(root, "bags/workflows/runtime/package.json", "{}");
  for (const name of [...removed, ...kept]) file(root, name);
  removeDevelopmentFiles(root);
  for (const name of removed) expect(existsSync(join(root, name)), name).toBe(false);
  for (const name of kept) expect(existsSync(join(root, name)), name).toBe(true);
});
it("keeps the real migration verifier's master decoder executable after production pruning", () => {
  const root = fixture(), verifier = join(releaseRoot(), "cli/scripts/verify-nodes.ts");
  const referencedHelper = /from "([^"]*master-join-token\.js)"/.exec(readFileSync(verifier, "utf8"))?.[1];
  expect(referencedHelper).toBeDefined();
  const relative = referencedHelper!.replace(/\.js$/, ".ts");
  const helper = file(root, join("cli/scripts", relative), readFileSync(join(dirname(verifier), relative), "utf8"));
  file(root, "cli/package.json", JSON.stringify({ type: "module" }));
  const development = file(root, "cli/test/unrelated.test.ts");
  mkdirSync(join(root, "node_modules"));
  symlinkSync(join(releaseRoot(), "cli/node_modules/zod"), join(root, "node_modules/zod"));
  removeDevelopmentFiles(root);
  expect(existsSync(development)).toBe(false);
  expect(existsSync(helper), "the shipped migration fixture must retain its imported decoder").toBe(true);
  const token = { v: 1, owner: "owner", name: "worker", worker: "worker", url: "https://owner.example", credential: `barry_wk_${"x".repeat(43)}` };
  const encoded = `barry_wj1.${Buffer.from(JSON.stringify(token)).toString("base64url")}`;
  const code = `import { decodeJoinToken } from ${JSON.stringify(pathToFileURL(helper).href)}; process.stdout.write(JSON.stringify(decodeJoinToken(${JSON.stringify(encoded)})));`;
  const decoded = spawnSync(process.execPath, ["--import", join(releaseRoot(), "node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", code], { cwd: root, encoding: "utf8", timeout: 30_000 });
  expect(decoded.status, decoded.stderr).toBe(0);
  expect(JSON.parse(decoded.stdout)).toEqual(token);
});
it("accepts internal relative links, rejects absolute and escaping links", () => {
  const root = fixture(); file(root, "target");
  symlinkSync("target", join(root, "link")); expect(() => checkLinks(root)).not.toThrow();
  symlinkSync(join(root, "target"), join(root, "absolute")); expect(() => checkLinks(root)).toThrow("escapes");
  rmSync(join(root, "absolute"));
  const outside = fixture(); file(outside, "target");
  symlinkSync(join("..", outside.split("/").at(-1)!, "target"), join(root, "escape"));
  expect(() => checkLinks(root)).toThrow("escapes");
});
it("scans built files, excludes third-party bytes, and does not follow links", () => {
  const root = fixture(); const key = `AKIA${"A".repeat(16)}`;
  file(root, "dist/x.js", key); file(root, "node_modules/pkg/x.js", key); file(root, "bags/x/dist/node_modules/pkg/x.js", key); file(root, "runtime/x", key);
  file(root, "bags/workflows/runtime/src/x.ts", key);
  const outside = fixture(); symlinkSync(file(outside, "x", key), join(root, "link"));
  expect(scanSecrets(root).sort()).toEqual(["bags/workflows/runtime/src/x.ts", "dist/x.js"].map(path => `${path}: matches \\bAKIA[0-9A-Z]{16}\\b`));
  expect(scanSecrets(root).join()).not.toContain(key);
});
it("renders the formula, rejects placeholders, and produces valid Ruby", () => {
  const root = fixture();
  const template = readFileSync(join(releaseRoot(), "cli/scripts/homebrew/barry.rb"), "utf8");
  const formula = renderFormula(template, join(root, "release with spaces.tar.gz"), "a".repeat(64), "0.10.0-beta.1");
  expect(formula).toContain("release%20with%20spaces.tar.gz"); expect(formula).not.toContain("@@");
  expect(formula.indexOf('  version "')).toBeLessThan(formula.indexOf('  sha256 "'));
  expect(formula.indexOf("  depends_on arch:")).toBeLessThan(formula.indexOf("  depends_on :macos"));
  expect(formula.indexOf("  keg_only ")).toBeLessThan(formula.indexOf("  depends_on "));
  expect(() => renderFormula("@@LEFT@@", "/tmp/a", "a", "1.0.0")).toThrow("placeholder");
  const path = file(root, "barry.rb", formula);
  expect(spawnSync("/usr/bin/ruby", ["-c", path], { encoding: "utf8" }).stdout).toBe("Syntax OK\n");
});
it("refuses to publish a formula whose release tag differs from its tarball version", () => {
  const root = fixture();
  file(root, "barry-1.2.3-darwin-arm64.tar.gz");
  const render = (tag: string) => spawnSync(process.execPath, [join(releaseRoot(), ".github/ci/render-release-formula.mjs"), root, tag, "barry-rocks/public-mirror"], { cwd: releaseRoot(), encoding: "utf8" });
  const mismatch = render("v0.0.0-pr57-test");
  expect(mismatch.status).not.toBe(0);
  expect(mismatch.stderr).toContain("does not match tarball version");
  expect(existsSync(join(root, "barry.rb"))).toBe(false);
  expect(render("v1.2.3").status).toBe(0);
  expect(readFileSync(join(root, "barry.rb"), "utf8")).toContain("https://github.com/barry-rocks/public-mirror/releases/download/v1.2.3/barry-1.2.3-darwin-arm64.tar.gz");
});
it("refuses output inside a checkout, including through a symlink", () => {
  const root = fixture();
  expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
  expect(() => assertOutputOutsideCheckout(join(root, "new/out"))).toThrow("outside");
  const outside = fixture(); symlinkSync(root, join(outside, "checkout"));
  expect(() => assertOutputOutsideCheckout(join(outside, "checkout/new/out"))).toThrow("outside");
  expect(() => assertOutputOutsideCheckout(join(outside, "out"))).not.toThrow();
});
it("requires darwin-arm64", () => {
  expect(() => assertPlatform("darwin", "arm64")).not.toThrow();
  expect(() => assertPlatform("linux", "arm64")).toThrow("darwin-arm64");
  expect(() => assertPlatform("darwin", "x64")).toThrow("darwin-arm64");
});

it("walks workspace imports and refuses missing runtime dependencies", async () => {
  const root = fixture();
  file(root, "workspace/package.json", JSON.stringify({ name: "fixture-workspace", type: "module", exports: "./index.js" }));
  file(root, "workspace/index.js", 'import "missing-runtime-package";');
  mkdirSync(join(root, "node_modules")); symlinkSync("../workspace", join(root, "node_modules/fixture-workspace"));
  const entry = file(root, "entry.js", 'import "fixture-workspace";');
  expect((await checkImports(root, [entry])).join("\n")).toContain('Could not resolve "missing-runtime-package"');
});
it("resolves third-party packages without walking their internals", async () => {
  const root = fixture();
  file(root, "node_modules/third-party/package.json", JSON.stringify({ name: "third-party", main: "./index.js" }));
  file(root, "node_modules/third-party/index.js", 'require("unavailable-third-party-internal");');
  const entry = file(root, "entry.js", 'import "third-party";');
  expect(await checkImports(root, [entry])).toEqual([]);
  expect(existsSync(join(root, "imports"))).toBe(false);
});
it("allows guarded optional imports", async () => {
  const root = fixture();
  const entry = file(root, "entry.js", 'try { await import("optional-fixture-package"); } catch {}');
  expect(await checkImports(root, [entry])).toEqual([]);
});
