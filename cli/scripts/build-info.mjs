import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkoutCommit } from "../bin/entry.js";

/** Archives carry the commit explicitly because git archive does not export .git. */
export function bundleBuildInfo(root, env = process.env) {
  const checkout = existsSync(join(root, ".git"));
  const commit = checkout ? checkoutCommit(root) : env.BARRY_BUILD_COMMIT;
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("CLI bundle needs a checkout HEAD or BARRY_BUILD_COMMIT for a source archive");
  const dirty = checkout && Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim());
  return { commit, builtAt: new Date().toISOString(), dirty };
}
