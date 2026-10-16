import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  copyFileSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SqliteDatabase } from "../stores/sqlite-connection.js";
export interface WorkArtifactBundle {
  kind: "owner-content-addressed";
  file: "work-artifacts.jsonl";
  digest: string;
  bytes: number;
  entries: number;
}
function verify(path: string, expected: string, bytes: number): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor),
      hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    if (!stat.isFile() || stat.size !== bytes) throw new Error("work artifact size mismatch");
    let total = 0,
      count: number;
    while (
      total <= bytes &&
      (count = readSync(descriptor, buffer, 0, Math.min(buffer.length, bytes - total + 1), null)) >
        0
    ) {
      total += count;
      hash.update(buffer.subarray(0, count));
    }
    if (total !== bytes || hash.digest("hex") !== expected)
      throw new Error("work artifact digest mismatch");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
/** Stream the authoritative SQLite reference set; no large history or artifact is materialized. */
export function bundleWorkArtifacts(
  db: SqliteDatabase,
  sourceRoot: string | undefined,
  destination: string,
  owner: string,
): WorkArtifactBundle | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_work_sources'").get())
    return undefined;
  if (!db.prepare("SELECT 1 FROM workflow_work_sources LIMIT 1").get()) return undefined;
  if (!sourceRoot || !isAbsolute(sourceRoot))
    throw new Error("snapshot requires the retained work artifact root");
  sourceRoot = realpathSync(sourceRoot);
  const targetRoot = join(destination, "work-artifacts");
  mkdirSync(targetRoot, { mode: 0o700 });
  writeFileSync(join(targetRoot, ".owner"), owner, { mode: 0o600 });
  const descriptor = openSync(
    join(destination, "work-artifacts.jsonl"),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  const hash = createHash("sha256");
  let bytes = 0,
    entries = 0;
  try {
    for (const row of db
      .prepare(
        "SELECT namespace_hash,digest,max(bytes) bytes FROM workflow_work_sources GROUP BY namespace_hash,digest ORDER BY namespace_hash,digest",
      )
      .iterate()) {
      const namespace = String(row.namespace_hash),
        digest = String(row.digest),
        size = Number(row.bytes);
      if (
        !/^[a-f0-9]{64}$/.test(namespace) ||
        !/^[a-f0-9]{64}$/.test(digest) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 1073741824
      )
        throw new Error("invalid work artifact reference");
      const sourceDirectory = join(sourceRoot, namespace);
      if (realpathSync(sourceDirectory) !== sourceDirectory)
        throw new Error("work artifact namespace is a symlink");
      const source = join(sourceDirectory, digest);
      verify(source, digest, size);
      const directory = join(targetRoot, namespace);
      mkdirSync(directory, { mode: 0o700, recursive: true });
      const target = join(directory, digest);
      copyFileSync(source, target);
      verify(target, digest, size);
      const line = Buffer.from(
        JSON.stringify({ namespace_hash: namespace, digest, bytes: size }) + "\n",
      );
      writeSync(descriptor, line);
      hash.update(line);
      bytes += line.length;
      entries++;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return {
    kind: "owner-content-addressed",
    file: "work-artifacts.jsonl",
    digest: hash.digest("hex"),
    bytes,
    entries,
  };
}
export function verifyWorkBundle(
  expected: WorkArtifactBundle | undefined,
  actual: WorkArtifactBundle | undefined,
): void {
  if (!expected && !actual) return;
  if (
    !expected ||
    !actual ||
    expected.kind !== actual.kind ||
    expected.file !== actual.file ||
    expected.digest !== actual.digest ||
    expected.bytes !== actual.bytes ||
    expected.entries !== actual.entries
  )
    throw new Error("snapshot work artifact dependency evidence mismatch");
}
