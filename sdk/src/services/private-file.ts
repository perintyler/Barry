import { chmodSync, closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write a generated config in a caller-owned directory, private on every reuse. */
export function writePrivateFile(path: string, contents: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!lstatSync(parent).isDirectory()) throw new Error("Private config parent must be an owned directory, not a symlink");
  chmodSync(parent, 0o700);
  try {
    if (!lstatSync(path).isFile()) throw new Error("Private config target must be a regular file");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Private config target must be a regular file");
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, contents, { encoding: "utf8" });
  } finally { closeSync(fd); }
}
