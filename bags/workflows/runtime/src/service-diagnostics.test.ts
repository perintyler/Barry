import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["info", "silent"])("startup failure uses structured stderr and respects LOG_LEVEL=%s", level => {
  const root = mkdtempSync(join(tmpdir(), "workflow-diagnostic-"));
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./service.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, HOME: root, BARRY_HOME: join(root, "instance"), TMPDIR: root, LOG_LEVEL: level, NODE_NO_WARNINGS: "1" },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    if (level === "silent") expect(child.stderr).toBe("");
    else {
      const records = child.stderr.trim().split("\n").map(line => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ service: "workflows.runtime", level: 50, msg: "workflows.start_failed", error: "BARRY_SECRET is required" });
      expect(records[0].stack).toContain("BARRY_SECRET is required");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not log invalid dedicated delegation key material on startup failure", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-secret-diagnostic-"));
  const keyPath = join(root, "delegation.json");
  writeFileSync(keyPath, "SYNTHETIC_PRIVATE_KEY_MUST_NOT_APPEAR");
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./service.ts", import.meta.url))], {
      env: { PATH: process.env.PATH, BARRY_HOME: join(root, "instance"), BARRY_SECRET: "fixture-service-secret", BARRY_WORKFLOW_DELEGATION_KEYS: keyPath, NODE_NO_WARNINGS: "1" },
      encoding: "utf8", timeout: 15000,
    });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    expect(child.stderr).toContain("Dedicated work delegation key configuration is unreadable or invalid.");
    expect(child.stderr).not.toContain("SYNTHETIC");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
