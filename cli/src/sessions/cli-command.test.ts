import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { thisCliCommand } from "./launch.js";

it("runs the absolute entry script from a hook's different cwd and empty PATH", () => {
  const directory = mkdtempSync(join(tmpdir(), "cli-command-"));
  const script = join(directory, "entry's script.cjs");
  const savedScript = process.argv[1];
  const savedFlags = process.execArgv.splice(0);
  vi.stubEnv("BARRY_IDENTITY_BINDING", "synthetic binding");
  try {
    writeFileSync(script, "process.stdout.write(JSON.stringify({ script: __filename, args: process.argv.slice(2) }));");
    process.argv[1] = relative(process.cwd(), script);
    const argument = "literal 'quoted' $(echo unintended)";
    const output = execFileSync("/bin/sh", ["-c", thisCliCommand("hook", "cursor", argument)], {
      cwd: directory,
      env: { PATH: "", HOME: directory },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(JSON.parse(output)).toEqual({ script: realpathSync(script), args: ["synthetic binding", "hook", "cursor", argument] });
  } finally {
    process.argv[1] = savedScript;
    process.execArgv.push(...savedFlags);
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
