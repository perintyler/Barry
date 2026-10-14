import {
  closeSync,
  chmodSync,
  chownSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/** Rotate only after the OS job has been unloaded, so no writer retains the old file. */
export function rotateLog(
  path: string,
  options: { keep?: number; maxBytes?: number } = {},
): void {
  const keep = options.keep ?? 3;
  if (!Number.isInteger(keep) || keep < 1)
    throw new Error("log retention must be a positive integer");
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  let stat;
  try {
    stat = fstatSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!stat.size || stat.size < (options.maxBytes ?? 0)) return;
  if (existsSync(`${path}.${keep}`)) unlinkSync(`${path}.${keep}`);
  for (let n = keep - 1; n >= 1; n--)
    if (existsSync(`${path}.${n}`))
      renameSync(`${path}.${n}`, `${path}.${n + 1}`);
  renameSync(path, `${path}.1`);
  writeFileSync(path, "", { mode: stat.mode & 0o7777 });
  if (process.getuid?.() === 0) chownSync(path, stat.uid, stat.gid);
  chmodSync(path, stat.mode & 0o7777);
}
/** Bounded reads keep a long-running service's log from filling management process memory. */
export function tailLog(path: string, lines: number): string {
  if (!Number.isInteger(lines) || lines < 1 || lines > 10000)
    throw new Error("log lines must be an integer between 1 and 10000");
  const read = (file: string): string => {
    if (!existsSync(file)) return "";
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size,
        length = Math.min(size, 1024 * 1024);
      const buffer = Buffer.alloc(length);
      const actual = readSync(fd, buffer, 0, length, size - length);
      const text = buffer.subarray(0, actual).toString("utf8");
      return size > length ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      closeSync(fd);
    }
  };
  let text = read(path);
  if (text.split("\n").length <= lines) text = read(`${path}.1`) + text;
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all.slice(-lines).join("\n");
}
