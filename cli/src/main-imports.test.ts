import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { releaseRoot } from "./releases/release.js";

it.each(["bundle", "tsx"])("keeps version and start help free of heavy modules (%s)", entry => {
  const root = releaseRoot(), scratch = mkdtempSync(join(tmpdir(), "barry-imports-"));
  try {
    for (const identity of [false, true]) for (const args of [["--version"], ["session", "start", "--help"]]) {
      const log = join(scratch, `${identity}-${args.length}.log`);
      const binding = identity ? ["--identity-binding", JSON.stringify({ id: 3, home: null, directory: "/tmp/example", instance: "unavailable" })] : [];
      const result = spawnSync(process.execPath, ["--import", join(root, "cli/test/record-imports.mjs"), join(root, "cli/bin/barry.js"), ...binding, ...args], {
        cwd: root, encoding: "utf8", env: { ...process.env, BARRY_BUNDLE: entry === "tsx" ? "0" : "1", BARRY_IMPORT_LOG: log, BARRY_TIMING: "1", BARRY_IDENTITY: "example" }, timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(!identity && args.length > 1 ? 1 : 0);
      expect(result.stderr).toContain(`entry: ${entry}`);
      expect(readFileSync(log, "utf8")).not.toMatch(/(?:\/express\/|express@|@modelcontextprotocol\/sdk|@modelcontextprotocol\+sdk|\/esbuild\/|esbuild@|@inquirer[+/]|@ag-ui[+/]core)/);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
