import { spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "@barry-rocks/sdk/internal/services";
import { barryCacheDir } from "@barry-rocks/sdk/services";
/** Detached fallback after handoff, throttled across CLI processes. The builder owns the lock. */
export function queueStaleBagBuild(): void {
  try {
    const directory = join(barryCacheDir(), "bag-build");
    const release = acquireLock(directory, "check");
    try {
    const marker = join(directory, "last-check");
    try { if (Date.now() - statSync(marker).mtimeMs < 10 * 60 * 1000) return; } catch { /* First check. */ }
    mkdirSync(directory, { recursive: true });
    writeFileSync(marker, String(Date.now()));
    const entry = process.env.BARRY_CLI_ENTRY ?? fileURLToPath(new URL("../../bin/barry.js", import.meta.url));
    const child = spawn(process.execPath, [entry, "bag", "build", "--if-stale"], { detached: true, stdio: "ignore", env: process.env });
    child.on("error", () => {});
    child.unref();
    } finally { release(); }
  } catch { /* Rebuilding never delays or refuses a session. */ }
}
