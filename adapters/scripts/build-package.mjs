import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = process.cwd();
const require = createRequire(join(root, "package.json"));
rmSync(join(root, "dist"), { recursive: true, force: true });
try {
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
} catch (error) {
  process.exitCode = typeof error.status === "number" ? error.status : 1;
}
