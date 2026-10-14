import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export interface Instance {
  id: string;
  home: string;
  uid?: number;
}
/** Creating an instance is explicit. Its ID survives directory moves. */
export function openInstance(home: string): Instance {
  const directory = resolve(home);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "instance.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return createInstance(directory, file);
  }
  // Every launchd label embeds the instance id, so a damaged record must never
  // be replaced by a fresh id: that would orphan every registered service.
  const damaged = `instance record ${file} is unreadable; restore it from a backup, or delete it only if this instance has no registered services`;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(damaged);
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9-]+$/.test(value.id)
  )
    throw new Error(damaged);
  const uid =
    "uid" in value && Number.isSafeInteger(value.uid)
      ? (value.uid as number)
      : statSync(file).uid;
  return { id: value.id, home: directory, uid };
}

function createInstance(directory: string, file: string): Instance {
  const instance = {
    id: randomUUID(),
    home: directory,
    uid: Number(process.env.SUDO_UID ?? process.getuid?.() ?? 501),
  };
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      tmp,
      JSON.stringify({ id: instance.id, uid: instance.uid }) + "\n",
      { mode: 0o600 },
    );
    try {
      linkSync(tmp, file);
    } finally {
      try { unlinkSync(tmp); } catch { /* already gone */ }
    }
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "EEXIST")
      return openInstance(directory);
    throw failure;
  }
  return instance;
}

/** Administrative preparation must still target the instance owner's login directory. */
export function instanceOwnerHome(instance: Instance): string {
  const uid = instance.uid ?? process.getuid?.();
  if (uid === process.getuid?.()) return homedir();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) throw new Error("invalid instance execution uid");
  const record = execFileSync("/usr/bin/dscacheutil", ["-q", "user", "-a", "uid", String(uid)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const directory = /^dir:\s*(\/[^\n]+)$/m.exec(record)?.[1];
  if (!directory) throw new Error(`cannot resolve login directory for instance uid ${uid}`);
  return directory;
}
