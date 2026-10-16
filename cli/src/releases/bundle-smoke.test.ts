import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { releaseRoot } from "./release.js";

it("runs the built version entries after relocation without TypeScript dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-bundle-smoke-"));
  try {
    mkdirSync(join(root, "cli/bin"), { recursive: true });
    cpSync(join(releaseRoot(), "cli/dist"), join(root, "cli/dist"), { recursive: true });
    for (const file of ["barry.js", "entry.js"]) cpSync(join(releaseRoot(), "cli/bin", file), join(root, "cli/bin", file));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "cli/version.json"), '{"version":"1.2.3"}');
    for (const binding of [[], ["--identity-binding", '{"id":1,"home":null}']]) {
      const result = spawnSync(process.execPath, [join(root, "cli/bin/barry.js"), ...binding, "--version"], { encoding: "utf8", env: { ...process.env, BARRY_TIMING: "1", BARRY_BUNDLE: "1" } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("1.2.3");
      expect(result.stderr).toContain("entry: bundle");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
