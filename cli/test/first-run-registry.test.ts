import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const command = fileURLToPath(new URL("../bin/barry.js", import.meta.url));
it("fresh-instance help stays quiet and the suggested bag doctor repair creates a snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-first-registry-"));
  const env = { PATH: "/usr/bin:/bin", HOME: root, BARRY_HOME: join(root, "instance"), TMPDIR: root, LOG_LEVEL: "silent" };
  try {
    const help = spawnSync(process.execPath, [command, "--help"], { env, encoding: "utf8", timeout: 30_000 });
    expect(help.status).toBe(0);
    expect(help.stderr).toBe("");
    const support = join(root, "instance/app-support");
    mkdirSync(support, { recursive: true });
    writeFileSync(join(support, "bags.snapshot.json"), "{ broken");
    const brokenHelp = spawnSync(process.execPath, [command, "--help"], { env, encoding: "utf8", timeout: 30_000 });
    expect(brokenHelp.status).toBe(0);
    expect(brokenHelp.stderr).toBe("");
    const doctor = spawnSync(process.execPath, [command, "bag", "doctor", "--fix"], { env, encoding: "utf8", timeout: 30_000 });
    expect(doctor.status, doctor.stderr + doctor.stdout).toBe(0);
    expect(existsSync(join(root, "instance/app-support/bags.snapshot.json"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
