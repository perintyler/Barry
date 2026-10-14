import { spawn } from "child_process";
import { join } from "path";
import { PATHS } from "../config.js";

export function redmarkCommand(args: string[]): void {
  const bin = join(PATHS.identityDir, "apps", "red-marker", "bin", "redmark");

  const child = spawn(bin, args, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
}
