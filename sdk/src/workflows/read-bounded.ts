import { openSync, closeSync, fstatSync, readSync, constants } from "node:fs";

/** Reject special files and bound allocation/read even if a local file grows. */
export function readBoundedFile(path: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid file byte limit");
  const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`file must be regular and no larger than ${maxBytes} bytes`);
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0, read: number;
    while (length < bytes.length && (read = readSync(file, bytes, length, bytes.length - length, null)) > 0) length += read;
    if (length === bytes.length) throw new Error("file grew during bounded read");
    return Buffer.from(bytes.subarray(0, length));
  } finally { closeSync(file); }
}
