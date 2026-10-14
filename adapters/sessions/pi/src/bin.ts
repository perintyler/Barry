import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOCAL_SHIM = join(homedir(), ".local", "bin", "pi");

/**
 * Resolve the Pi CLI binary path.
 */
export function resolvePiBin(): string {
  if (process.env.PI_BIN && existsSync(process.env.PI_BIN)) {
    return process.env.PI_BIN;
  }

  if (existsSync(LOCAL_SHIM)) return LOCAL_SHIM;

  try {
    const found = execFileSync("which", ["pi"], { encoding: "utf-8", stdio: "pipe" }).trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* not on PATH */
  }

  return "pi";
}
