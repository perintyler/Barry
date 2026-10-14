import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { barryCurrentDir } from "@barry-rocks/sdk/services";
import { barryVersion, readRelease, releaseRoot } from "./release.js";

interface SkewOptions {
  root?: string;
  args?: string[];
  run?: typeof spawnSync;
  signal?(signal: NodeJS.Signals): void;
}
/** Decide before main loads bags or opens stores. */
export async function dispatchSkew(options: SkewOptions = {}): Promise<boolean> {
  const root = options.root ?? releaseRoot(), args = options.args ?? process.argv.slice(2), release = readRelease(root);
  const version = args[0] === "--version" || args[0] === "-V";
  if (version) console.log(release?.version ?? barryVersion(root));
  if (!release) return version;
  const current = barryCurrentDir();
  let stat;
  try { stat = lstatSync(current); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return version; }
  if (!stat.isSymbolicLink() || !existsSync(current)) return version;
  const active = readRelease(current);
  if (active?.commit === release.commit) return version;
  const target = resolve(dirname(current), readlinkSync(current));
  const description = active ? `release ${active.version}` : `the linked checkout at ${target}`;
  const notice = `barry: release ${release.version} is installed, but this instance runs ${description}; running it there. barry upgrade switches.`;
  if (version) { console.error(notice); return true; }
  if (args[0] === "upgrade" || args[0] === "uninstall") return false;
  console.error(notice);
  const env: NodeJS.ProcessEnv = { ...process.env, BARRY_RELEASE_SKEW: notice };
  for (const name of ["BARRY_DIR", "BARRY_BUILTIN_DIR", "BARRY_HOOK_DISPATCHER", "BARRY_NODE"]) delete env[name];
  if (!active) {
    const { linkedNode } = await import("./current.js");
    const node = linkedNode();
    if (!node) throw new Error(`Cannot tell which Node the linked checkout at ${target} runs; run \`BARRY_NODE=<node> barry upgrade\`.`);
    env.BARRY_NODE = node;
  }
  const result: SpawnSyncReturns<Buffer> = (options.run ?? spawnSync)(join(current, "bin/barry"), args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) (options.signal ?? (signal => { process.kill(process.pid, signal); }))(result.signal);
  process.exitCode = result.status ?? 1;
  return true;
}
