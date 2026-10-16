import { realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { boundHasContent } from "../bounds/merge-bounds.js";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import { workProcessProgramSchema, type WorkProcessProgram } from "./work-contracts.js";
import type { WorkArtifactStore } from "./work-artifacts.js";
import { readBoundedFile } from "./read-bounded.js";
import { WorkflowError } from "./errors.js";
import { readProcessBundle } from "./work-process-bundle.js";

export function assertProcessProgramBundle(program: WorkProcessProgram, bytes: Buffer): void {
  const files = readProcessBundle(bytes).files;
  if (!program.bundle || files.find(file => file.path === program.bundle!.entry)?.digest !== program.source_digest ||
    program.argv.some(value => typeof value !== "string" && "file" in value && !files.some(file => file.path === value.file)))
    throw new WorkflowError("WorkSourceManifestInvalid", "Retained source closure differs from the program entry or argument files.", 409);
}

/** Darwin platform executables may only launch at their sealed-system path.
 * The longest matching mount must itself be sealed/read-only; a writable
 * overlay or another OS is ineligible. No mutable host-path runtime fallback. */
export function sealedSystemRuntime(path: string): boolean {
  if (process.platform !== "darwin" || !["/bin/", "/usr/bin/", "/System/"].some(prefix => path.startsWith(prefix)) || realpathSync(path) !== path) return false;
  const mounts = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 1000, env: {} }).split("\n").flatMap(line => {
    const match = /^.+ on (.+) \(([^)]+)\)$/.exec(line);
    return match && (match[1] === "/" || path === match[1] || path.startsWith(match[1]! + "/")) ? [{ path: match[1]!, flags: match[2]!.split(", ") }] : [];
  }).sort((a, b) => b.path.length - a.path.length);
  return mounts[0]?.flags.includes("sealed") === true && mounts[0].flags.includes("read-only");
}
export function assertProcessProgramRuntime(program: WorkProcessProgram): void {
  if (!program.runtime_path) return;
  if (!sealedSystemRuntime(program.runtime_path)) throw new WorkflowError("WorkRuntimeChanged", "The runtime is not on a sealed read-only system mapping.", 409);
  const bytes = readBoundedFile(program.runtime_path, program.runtime.bytes);
  if (bytes.length !== program.runtime.bytes || createHash("sha256").update(bytes).digest("hex") !== program.runtime.digest)
    throw new WorkflowError("WorkRuntimeChanged", "The sealed runtime differs from the accepted runtime bytes.", 409);
}
export function assertProcessProgramScope(program: WorkProcessProgram): void {
  if (!program.bundle && (program.source_environment?.length || program.argv.some(value => typeof value !== "string" && "file" in value)))
    throw new WorkflowError("WorkSourceManifestInvalid", "Source-relative arguments and environment require a retained closure.", 409);
  const { fingerprint, ...scope } = program.scope;
  if (program.scope.tools["bash:Bash"] !== "write" || !program.scope.contracts?.["bash:Bash"] || boundHasContent(program.scope.bound ?? undefined) || boundFingerprint(scope) !== fingerprint)
    throw new WorkflowError("UnsupportedProcessProgram", "Raw process execution requires the retained unbounded Bash write grant.", 409);
  if (program.secret_names.length && (program.credential_owner.kind === "none" || program.credential_owner.kind === "identity" && program.credential_owner.identity !== program.scope.identity || program.credential_owner.kind === "installation" && (program.scope.identity !== undefined || program.credential_owner.installation !== program.installation)))
    throw new WorkflowError("UnsupportedProcessProgram", "Declared secrets require an explicit retained credential owner.", 409);
}
export function assertProcessProgramDirectory(program: WorkProcessProgram): void {
  const current = statSync(program.cwd.path);
  if (!current.isDirectory() || realpathSync(program.cwd.path) !== program.cwd.path || current.dev !== program.cwd.device || current.ino !== program.cwd.inode)
    throw new WorkflowError("WorkWorkspaceChanged", "The retained local working directory is unavailable or changed.", 409);
}
/** Trusted installation resolver only. No program is imported or launched here. */
export function prepareProcessProgram(options: {
  artifacts: WorkArtifactStore; source: string; runtime?: string;
  activity_type: string; installation: string; scope: WorkProcessProgram["scope"];
  argv: WorkProcessProgram["argv"]; cwd: string; env?: Record<string, string>;
  credential_owner?: WorkProcessProgram["credential_owner"]; secret_names?: string[]; output: WorkProcessProgram["output"];
  bundle?: WorkProcessProgram["bundle"]; sourceEnvironment?: string[];
}) {
  const cwd = realpathSync(options.cwd), directory = statSync(cwd);
  if (!directory.isDirectory()) throw new Error("process working directory must be a directory");
  const retain = (path: string) => options.artifacts.stage(readBoundedFile(realpathSync(path), options.artifacts.maxArtifactBytes), { purpose: "source", owner_identity: null, media_type: "application/octet-stream" });
  const source = retain(options.source), runtime = options.runtime ? retain(options.runtime) : source;
  const runtimePath = realpathSync(options.runtime ?? options.source);
  const program = workProcessProgramSchema.parse({ activity_type: options.activity_type, installation: options.installation, source_digest: source.digest,
    runtime, ...(sealedSystemRuntime(runtimePath) ? { runtime_path: runtimePath } : {}), credential_owner: options.credential_owner ?? { kind: "none" }, argv: options.argv, source_name: basename(options.source), cwd: { path: cwd, device: directory.dev, inode: directory.ino },
    scope: options.scope, env: options.env ?? {}, secret_names: options.secret_names ?? [], output: options.output,
    ...(options.bundle ? { bundle: options.bundle } : {}), ...(options.sourceEnvironment ? { source_environment: options.sourceEnvironment } : {}) });
  assertProcessProgramScope(program);
  if (program.bundle) assertProcessProgramBundle(program, options.artifacts.verify(program.bundle.source));
  return { program, sources: [...new Map([source, runtime, ...(program.bundle ? [program.bundle.source] : [])].map(ref => [ref.digest, ref])).values()], source };
}
