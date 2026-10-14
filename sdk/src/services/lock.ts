import { chownSync, statSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
/** Files written by sudo still belong to the instance's directory owner. */
export function matchDirectoryOwner(path: string): void {
  if (process.getuid?.() !== 0) return;
  const { uid, gid } = statSync(dirname(path));
  chownSync(path, uid, gid);
}
/** Refuse concurrent mutation, recover a dead owner's lock, never steal a live lock. */
export function acquireLock(home: string, name: string): () => void {
  mkdirSync(home, { recursive: true });
  const path = join(home, `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      matchDirectoryOwner(path);
      return () => {
        if (readFileSync(path, "utf8") === String(process.pid))
          unlinkSync(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(readFileSync(path, "utf8"));
      if (!Number.isInteger(owner) || owner < 1)
        throw new Error(`invalid lock ${path}; inspect it before recovery`);
      if (isAlive(owner)) throw new Error(`${name} is in use by pid ${owner}`);
      unlinkSync(path);
    }
  }
  throw new Error(`could not acquire ${name}`);
}
