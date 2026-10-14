// Builds every workspace package that other packages import from dist/: the
// sdk, the artifacts bag and the compiled adapters. A fresh checkout has none
// of those directories, and every import of them fails until they exist, so
// this runs before any typecheck, lint or test does.
//
// Each waits for what it imports: the sdk first, since the artifacts bag and
// every adapter import its declarations, then the artifacts bag, then the
// adapters in waves of the ones whose own adapter dependencies are built.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = join(repoRoot, "bags/artifacts");

function build(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["run", "build"], { cwd: dir, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`${relative(repoRoot, dir)}: build exited ${code}`))));
  });
}

await build(join(repoRoot, "sdk"));
await build(artifacts);

// Adapters build in waves: an adapter waits only for the adapters it depends on.
const adapters = new Map();
for (const kind of readdirSync(join(repoRoot, "adapters"), { withFileTypes: true })) {
  if (!kind.isDirectory()) continue;
  for (const entry of readdirSync(join(repoRoot, "adapters", kind.name), { withFileTypes: true })) {
    const dir = join(repoRoot, "adapters", kind.name, entry.name);
    if (!entry.isDirectory() || !existsSync(join(dir, "package.json"))) continue;
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (typeof manifest.scripts?.build !== "string") continue;
    adapters.set(manifest.name, { dir, deps: Object.keys(manifest.dependencies ?? {}) });
  }
}
const built = new Set();
while (built.size < adapters.size) {
  const wave = [...adapters].filter(([name, { deps }]) =>
    !built.has(name) && deps.every(dep => !adapters.has(dep) || built.has(dep)));
  if (wave.length === 0) throw new Error("adapters depend on each other in a cycle; they cannot be built in order");
  await Promise.all(wave.map(([, { dir }]) => build(dir)));
  for (const [name] of wave) built.add(name);
}
