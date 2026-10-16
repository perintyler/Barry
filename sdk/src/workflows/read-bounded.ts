import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";

/** Reject special files and bound allocation/read even if a local file grows.
 * `ownerOnly` adds secret custody: no leaf symlink, one link, owned by this user, no group/other bits. */
export function readBoundedFile(path: string, maxBytes: number, options: { ownerOnly?: boolean } = {}): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid file byte limit");
  const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (options.ownerOnly ? constants.O_NOFOLLOW : 0));
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`file must be regular and no larger than ${maxBytes} bytes`);
    if (options.ownerOnly && (stat.nlink !== 1 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()))
      throw new Error("file must be a single-link owner-only file");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0, read: number;
    while (length < bytes.length && (read = readSync(file, bytes, length, bytes.length - length, null)) > 0) length += read;
    if (length === bytes.length) throw new Error("file grew during bounded read");
    return Buffer.from(bytes.subarray(0, length));
  } finally { closeSync(file); }
}
