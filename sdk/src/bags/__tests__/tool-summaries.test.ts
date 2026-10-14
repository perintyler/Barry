import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "../manifest.js";
import { loadBagToolSummaries } from "../tool-definitions.js";

let bagDir: string;
let buildDir: string;
const previousBuildDir = process.env.BARRY_BAGS_BUILD_DIR;

beforeEach(() => {
  bagDir = mkdtempSync(join(tmpdir(), "summary-bag-"));
  buildDir = mkdtempSync(join(tmpdir(), "summary-build-"));
  process.env.BARRY_BAGS_BUILD_DIR = buildDir;
  writeFileSync(join(bagDir, "package.json"), JSON.stringify({ name: "summary-bag", version: "0.0.0", type: "module" }));
  writeFileSync(join(bagDir, "bag.yaml"), "name: summary-bag\ndescription: A bag whose one tool gets renamed\n");
});

afterEach(() => {
  if (previousBuildDir === undefined) delete process.env.BARRY_BAGS_BUILD_DIR;
  else process.env.BARRY_BAGS_BUILD_DIR = previousBuildDir;
  rmSync(bagDir, { recursive: true, force: true });
  rmSync(buildDir, { recursive: true, force: true });
});

function writeTool(name: string, secondsAhead: number): void {
  const path = join(bagDir, "tools.ts");
  writeFileSync(path, `export const tool = { name: "${name}", namespace: "demo", access: "read", description: "d", schema: {}, handler: () => "ok" };\n`);
  // A rebuild is keyed by mtime; move it on past the last build.
  const at = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(path, at, at);
}

function bag() {
  const manifest = parseManifest(bagDir);
  if (!manifest) throw new Error("fixture manifest did not parse");
  return { name: "summary-bag", source: { type: "local" as const, path: bagDir }, manifest };
}

describe("tool summaries", () => {
  it("follow a rebuilt bundle in a process that imported the old one", async () => {
    writeTool("ask", 0);
    expect((await loadBagToolSummaries(bag()))?.map((tool) => tool.toolName)).toEqual(["ask"]);

    // A long-lived service saw the first bundle. The bag is rebuilt with the
    // tool renamed; the summary it writes must describe the new bundle.
    writeTool("make", 5);
    expect((await loadBagToolSummaries(bag()))?.map((tool) => tool.toolName)).toEqual(["make"]);
  });
});
