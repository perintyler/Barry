/** Unregistered repository entry point; central command integration belongs to main. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { diagnoseWorkOps, type WorkOpsDiagnosticRole } from "./work-ops-diagnostics.js";
import { inventoryWorkOps, regularFile, verifyWorkOpsFiles } from "./work-ops.js";

function json(path: string): unknown {
  regularFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) throw new Error("InputLimit");
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break; length += count;
    }
    const after = fstatSync(fd), leaf = lstatSync(path);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || leaf.dev !== after.dev || leaf.ino !== after.ino || leaf.isSymbolicLink()) throw new Error("InputChanged");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally { closeSync(fd); }
}

export function runWorkOps(args: string[]): { result: unknown; exitCode: number } {
  const [operation, ...rest] = args;
  if (operation === "inventory" && rest.length === 1) return { result: inventoryWorkOps(json(rest[0])), exitCode: 2 };
  if (operation === "verify-files" && rest.length === 2) {
    const result = verifyWorkOpsFiles(rest[0], json(rest[1]));
    // Even verified bytes do not establish backup completeness.
    return { result, exitCode: result.filesVerified ? 2 : 1 };
  }
  if (operation === "diagnose-sealed" && rest.length === 3) {
    const result = diagnoseWorkOps(rest[1], rest[2], rest[0] as WorkOpsDiagnosticRole);
    return { result, exitCode: result.issues.length ? 1 : 0 };
  }
  throw new Error("Usage: inventory <absolute-spec.json> | verify-files <absolute-directory> <absolute-members.json> | diagnose-sealed <executor|broker|sessions|runtime> <absolute-copy.db> <sha256>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { result, exitCode } = runWorkOps(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2)); process.exitCode = exitCode;
  } catch {
    // Never echo arbitrary JSON, SQL errors or configuration values to logs.
    console.error("WorkOpsRefused: check arguments, sealed-copy provenance, paths and input schema. See sdk/docs/work-sessions-operations.md.");
    process.exitCode = 1;
  }
}
