/** CLI-local observations. This is deliberately not a recovery manifest. */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

const absolute = z.string().min(1).max(4096).refine(path => isAbsolute(path) && resolve(path) === path);
function containsPath(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child === "" || !isAbsolute(child) && child !== ".." && !child.startsWith("../");
}
export const workOpsInventorySchema = z.strictObject({
  version: z.literal(1),
  roots: z.array(z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), path: absolute,
    role: z.enum(["managed", "data", "worker", "runtime", "artifact", "spool", "catalog", "projection", "lock"]),
    owner: z.string().min(1).max(200), bindings: z.array(z.string().min(1).max(200)).max(100) })).min(1).max(100),
  // Credential paths are references only: never traverse or hash their contents.
  credentials: z.array(z.strictObject({ id: z.string().min(1).max(200), path: absolute, owner: z.string().min(1).max(200) })).max(100),
}).superRefine((value, context) => {
  if (new Set(value.roots.map(root => root.id)).size !== value.roots.length)
    context.addIssue({ code: "custom", message: "duplicate root id" });
  for (let index = 0; index < value.roots.length; index++) {
    for (let other = 0; other < index; other++) {
      if (containsPath(value.roots[index].path, value.roots[other].path) || containsPath(value.roots[other].path, value.roots[index].path))
        context.addIssue({ code: "custom", message: "overlapping inventory roots" });
    }
  }
});
export type WorkOpsInventory = z.infer<typeof workOpsInventorySchema>;
export interface FileObservation { root: string; path: string; bytes: number; kind: "sqlite" | "wal" | "shm" | "journal" | "lock" | "file" }
export interface OpsIssue { code: string; root?: string; path?: string }

/** No symlink in any component; no special/hardlinked file reads. */
export function regularFile(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error("UnsafePath");
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1) throw new Error("UnsafeFile");
}

/** Bounded, streaming hash; detect replacement and writes during observation. */
export function hashOpsFile(path: string, maxBytes = 4 * 1024 ** 3): { bytes: number; sha256: string } {
  regularFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error("FileLimit");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (bytes <= before.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size + 1 - bytes), bytes);
      if (!count) break;
      hash.update(buffer.subarray(0, count)); bytes += count;
    }
    const after = fstatSync(fd), leaf = lstatSync(path);
    if (bytes !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || leaf.dev !== after.dev || leaf.ino !== after.ino)
      throw new Error("FileChanged");
    return { bytes, sha256: hash.digest("hex") };
  } finally { closeSync(fd); }
}

/** Enumerate nested and arbitrary configured roots without opening databases. */
export function inventoryWorkOps(input: unknown, maxEntries = 100_000) {
  const inventory = workOpsInventorySchema.parse(input), files: FileObservation[] = [], issues: OpsIssue[] = [];
  let entries = 0;
  for (const root of inventory.roots) {
    const visit = (path: string, depth: number): void => {
      if (++entries > maxEntries || depth > 64) throw new Error("InventoryLimit");
      const info = lstatSync(path);
      if (info.isSymbolicLink() || realpathSync(path) !== path) throw new Error("UnsafePath");
      if (info.isDirectory()) {
        // Stream entries so a single huge directory cannot defeat maxEntries.
        const directory = opendirSync(path);
        try {
          let entry;
          while ((entry = directory.readSync()) !== null) visit(join(path, entry.name), depth + 1);
        } finally { directory.closeSync(); }
      } else {
        if (!info.isFile() || info.nlink !== 1) throw new Error("UnsafeFile");
        const kind = /(?:\.db|\.sqlite)$/.test(path) ? "sqlite" : path.endsWith("-wal") ? "wal"
          : path.endsWith("-shm") ? "shm" : path.endsWith("-journal") ? "journal" : /lock/.test(path) ? "lock" : "file";
        files.push({ root: root.id, path: relative(root.path, path) || ".", bytes: info.size, kind });
      }
    };
    // A root enclosing a credential would expose its presence as ordinary data;
    // refuse the whole root so later tooling cannot accidentally copy secrets.
    if (inventory.credentials.some(credential => containsPath(root.path, credential.path))) {
      issues.push({ code: "CredentialInsideRoot", root: root.id }); continue;
    }
    try { visit(root.path, 0); } catch { issues.push({ code: "RootUnavailableOrUnsafe", root: root.id }); }
  }
  return { version: 1 as const, scope: "configured-filesystem-observation" as const, complete: false as const,
    restoreReady: false as const, recoveryPoint: null,
    roots: inventory.roots, credentials: inventory.credentials, files: files.sort((a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path)), issues,
    blockers: ["ConfiguredRootsAreNotAuthoritativeDiscovery", "CrossStoreCaptureNotEstablished", "ReferencedCustodyNotValidated"],
    totals: { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), walBytes: files.filter(file => file.kind === "wal").reduce((sum, file) => sum + file.bytes, 0) } };
}

export const workOpsFileManifestSchema = z.strictObject({
  version: z.literal(1), scope: z.literal("local-file-verification"),
  members: z.array(z.strictObject({ path: z.string().min(1).max(4096), bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(100_000),
}).superRefine((value, context) => {
  if (new Set(value.members.map(member => member.path)).size !== value.members.length)
    context.addIssue({ code: "custom", message: "duplicate member" });
});

/** Exact supplied bytes only. No publication, restore, activation or completeness attestation. */
export function verifyWorkOpsFiles(directory: string, input: unknown) {
  const manifest = workOpsFileManifestSchema.parse(input), issues: OpsIssue[] = [];
  if (!isAbsolute(directory) || resolve(directory) !== directory || realpathSync(directory) !== directory || !lstatSync(directory).isDirectory())
    throw new Error("UnsafeBackupRoot");
  for (const member of manifest.members) {
    const path = resolve(directory, member.path);
    if (isAbsolute(member.path) || relative(directory, path).startsWith("..") || path === directory || member.path.split("/").some(part => part === ".." || part === "." || part === "")) {
      issues.push({ code: "UnsafeMember", path: member.path }); continue;
    }
    try {
      const actual = hashOpsFile(path);
      if (actual.bytes !== member.bytes || actual.sha256 !== member.sha256) issues.push({ code: "MemberMismatch", path: member.path });
    } catch { issues.push({ code: "MemberUnavailableOrUnsafe", path: member.path }); }
  }
  return { scope: manifest.scope, filesVerified: issues.length === 0, complete: false as const, restoreReady: false as const,
    recoveryPoint: null, issues, blockers: ["MemberListIsNotCustodyClosure", "CrossStoreCaptureNotEstablished"] };
}
