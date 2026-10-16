import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { buildBag, ensureToolsBuilt, bagBuildInputStamp } from "../build.js";

// Preserve every unresolved-import diagnostic and its location in the structured build result.
// Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-040
function bagWithUnresolvableImport(): { name: string; bagDir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), "bag-build-err-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), `import { x } from "@definitely/not-installed";\nexport const a = x;\n`);
  writeFileSync(join(dir, "tools.ts"), `export { a } from "./src/a.js";\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "errbag", version: "0.0.0" }));
  return { name: "errbag", bagDir: dir, entry: join(dir, "tools.ts") };
}

describe("a failed bag build reports which errors failed it", () => {
  it("carries esbuild's per-error detail, not just the count header", async () => {
    const result = await buildBag(bagWithUnresolvableImport());

    expect(result.ok).toBe(false);

    // The regression: esbuild's `.message` starts with "Build failed with N
    // errors:" and puts the diagnostics on LATER lines. The CLI printed only
    // line [0], so every failure rendered as that header and nothing else.
    // Structured errors make the detail survive regardless of formatting.
    expect(result.errors, "structured esbuild errors must be preserved").toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);

    const text = result.errors!.map((e) => e.text).join(" ");
    expect(text).toContain("@definitely/not-installed");

    // A location is what makes the error actionable.
    const located = result.errors!.find((e) => e.file);
    expect(located, "at least one error must carry a file location").toBeDefined();
    expect(located!.line).toBeGreaterThan(0);
  });

  it("never reports the count header as the whole failure", async () => {
    const result = await buildBag(bagWithUnresolvableImport());
    const firstLineOnly = String(result.error).split("\n")[0];

    // Proves the old formatting was information-free: the first line names no
    // file, no import, nothing but a count.
    expect(firstLineOnly).not.toContain("@definitely/not-installed");
    // ...while the full message does.
    expect(String(result.error)).toContain("@definitely/not-installed");
  });
});

// tsx loads a .js file with no package.json above it as CommonJS, while plain
// Node detects ESM; a bundle that only worked one way (amazon-commerce, whose
// bundled bottleneck uses a direct eval) loaded in production and threw in dev.
describe("a successful bag build", () => {
  it("declares its output as ESM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bag-build-ok-"));
    writeFileSync(join(dir, "tools.ts"), "export const ok = 1;\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "okbag", version: "0.0.0" }));
    const previous = process.env.BARRY_BAGS_BUILD_DIR;
    process.env.BARRY_BAGS_BUILD_DIR = join(dir, "out");
    try {
      const result = await buildBag({ name: "okbag", bagDir: dir, entry: join(dir, "tools.ts") });
      expect(result.ok).toBe(true);
      expect(JSON.parse(readFileSync(join(dirname(result.outFile!), "package.json"), "utf8"))).toEqual({ type: "module" });
    } finally {
      if (previous === undefined) delete process.env.BARRY_BAGS_BUILD_DIR;
      else process.env.BARRY_BAGS_BUILD_DIR = previous;
    }
  });
});


it("caches a failed missing build without retrying it on the next launch", async () => {
  const bag = bagWithUnresolvableImport();
  await expect(ensureToolsBuilt(bag)).rejects.toThrow("@definitely/not-installed");
  const firstStamp = bagBuildInputStamp(bag);
  await expect(ensureToolsBuilt(bag)).rejects.toMatchObject({ cachedBuildFailure: true });
  writeFileSync(join(bag.bagDir, "src", "a.ts"), "export const a = 1;\n");
  expect(bagBuildInputStamp(bag)).not.toBe(firstStamp);
  // A fixed bag must recover on this launch without waiting for maintenance.
  await expect(ensureToolsBuilt(bag)).resolves.toMatch(/tools\.js$/);
});

 it("invalidates a missing dependency failure when dependencies are installed", async () => {
  const bag = bagWithUnresolvableImport();
  await expect(ensureToolsBuilt(bag)).rejects.toThrow("@definitely/not-installed");
  const dependency = join(bag.bagDir, "node_modules", "@definitely", "not-installed");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "@definitely/not-installed", main: "index.js" }));
  writeFileSync(join(dependency, "index.js"), "export const x = 1;");
  await expect(ensureToolsBuilt(bag)).resolves.toMatch(/tools\.js$/);
 });
