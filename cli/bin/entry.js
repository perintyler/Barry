import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Read Git's current commit without starting another process (including worktrees). */
export function checkoutCommit(root) {
  try {
    let git = join(root, ".git");
    if (!existsSync(join(git, "HEAD"))) {
      const pointer = readFileSync(git, "utf8").trim();
      if (!pointer.startsWith("gitdir: ")) return undefined;
      git = resolve(root, pointer.slice(8));
    }
    const head = readFileSync(join(git, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5);
    let common = git;
    if (existsSync(join(git, "commondir"))) common = resolve(git, readFileSync(join(git, "commondir"), "utf8").trim());
    for (const dir of [git, common]) {
      if (existsSync(join(dir, ref))) return readFileSync(join(dir, ref), "utf8").trim();
    }
    return readFileSync(join(common, "packed-refs"), "utf8").split("\n").find(line => line.endsWith(` ${ref}`))?.split(" ")[0];
  } catch { return undefined; }
}

export function selectEntry(root, name, env = process.env) {
  if (env.BARRY_BUNDLE === "0") return { entry: "tsx" };
  const bundle = join(root, "cli", "dist", `${name}.js`);
  if (!existsSync(bundle)) return { entry: "tsx" };
  let metadata;
  try { metadata = JSON.parse(readFileSync(join(root, "cli/dist/build.json"), "utf8")); }
  catch { return { entry: "tsx", stale: true }; }
  if (existsSync(join(root, ".git"))) {
    if (metadata.commit !== checkoutCommit(root) || !metadata.inputs || typeof metadata.inputs !== "object" || Array.isArray(metadata.inputs)) return { entry: "tsx", stale: true };
    try {
      for (const [path, stamp] of Object.entries(metadata.inputs)) {
        const current = statSync(resolve(root, path));
        if (stamp !== `${current.mtimeMs}:${current.ctimeMs}:${current.size}`) return { entry: "tsx", stale: true };
      }
    } catch { return { entry: "tsx", stale: true }; }
  }
  return { entry: "bundle", path: bundle, commit: metadata.commit };
}

export async function prepareEntry(root, name) {
  const selected = selectEntry(root, name);
  process.env.BARRY_TIMING_ENTRY = selected.entry;
  if (selected.commit) process.env.BARRY_CLI_BUILD_COMMIT = selected.commit;
  if (selected.stale) process.stderr.write("barry: CLI bundle is stale; using sources. Run: pnpm --dir cli build\n");
  try {
    const { enableCompileCache } = await import("node:module");
    const directory = process.env.BARRY_HOME ? join(process.env.BARRY_HOME, "cache/compile-cache") : join(homedir(), "Library/Caches/Barry/compile-cache");
    mkdirSync(directory, { recursive: true });
    enableCompileCache?.(directory);
  } catch { /* Older Node still runs the source entry. */ }
  if (selected.entry === "tsx") {
    const { register } = await import("tsx/esm/api");
    register();
  }
  if (process.env.BARRY_TIMING === "1") performance.mark("bin:loader-ready");
  return selected;
}
