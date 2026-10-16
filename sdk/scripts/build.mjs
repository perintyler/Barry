import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const paths = {};
// Build self-imports from source without exposing TypeScript to package consumers.
for (const [subpath, entry] of Object.entries(manifest.exports)) {
  const target = typeof entry === "string" ? entry : entry.import;
  if (!target?.startsWith("./dist/")) continue;
  const source = target.replace("./dist/", "./src/").replace(/\.js$/, ".ts");
  const name = subpath === "." ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
  paths[name] = [resolve(root, source)];
}
const scratch = mkdtempSync(join(tmpdir(), "barry-sdk-build-"));
const config = join(scratch, "tsconfig.json");
writeFileSync(config, JSON.stringify({
  extends: join(root, "tsconfig.build.json"),
  compilerOptions: { paths },
}));
rmSync(join(root, "dist"), { recursive: true, force: true });
let status = 0;
try {
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", config], { cwd: root, stdio: "inherit" });
  copyFileSync(join(root, "src/adapters/models/vendors/shipped-models.yaml"), join(root, "dist/adapters/models/vendors/shipped-models.yaml"));
} catch (error) {
  status = typeof error.status === "number" ? error.status : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = status;
