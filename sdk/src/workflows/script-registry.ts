import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadAllBags } from "../bags/loader.js";
import { listAllActions, isScriptAction, type ScriptAction } from "../actions/action-registry.js";
import { resolveActionRun } from "../actions/action-run-spec.js";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import type { WorkProcessProgram } from "./work-contracts.js";
import type { WorkArtifactStore, WorkArtifactRef } from "./work-artifacts.js";
import { readBoundedFile } from "./read-bounded.js";
import { prepareProcessBundle } from "./work-process-bundle.js";
import { sealedSystemRuntime } from "./work-process-program.js";
import { WorkflowError } from "./errors.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { workAdmissionSchema } from "./work-contracts.js";
import { artifactAbi, type WorkflowArtifact } from "./artifacts.js";

const absolute = z.string().max(4096).refine(value => isAbsolute(value) && !value.includes("\0"));
const relative = z.string().min(1).max(4096).refine(value => !value.includes("\\") && !value.includes("\0") && value.split("/").every(part => part && part !== "." && part !== ".."));
export const scriptResourceManifestSchema = z.strictObject({ version: z.literal(1), scripts: z.array(z.strictObject({
  reference: z.string().min(1).max(200).regex(/^[^:@]+:[^:@]+$/),
  resource_policy: z.literal("closed"), allowed_roots: z.array(absolute).min(1).max(100),
  entry: relative, files: z.array(z.strictObject({ path: relative, source: absolute })).min(1).max(10000),
  arguments: z.array(z.strictObject({ index: z.number().int().nonnegative().max(999), path: relative, format: z.enum(["path", "file-url"]).default("path") })).max(1000),
})).max(200) }).refine(value => new Set(value.scripts.map(script => script.reference)).size === value.scripts.length);
export type ScriptResourceManifest = z.infer<typeof scriptResourceManifestSchema>;
export interface InstalledScript {
  action: ScriptAction;
  type: string;
  source: WorkArtifactRef;
  sources: WorkArtifactRef[];
  program: Omit<WorkProcessProgram, "scope" | "credential_owner" | "input_digest">;
}
function binary(command: string): string {
  for (const path of isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, command))) {
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return realpathSync(path); } catch { /* Try the next explicit PATH entry. */ }
  }
  throw new WorkflowError("WorkRuntimeUnavailable", "The installed script runtime is unavailable.", 409);
}

/** Internal resource policy accompanies the installation; it is never supplied
 * by a task caller and adds no action.yaml fields. Capturing does not run code. */
export function installedScripts(actions: readonly ScriptAction[], manifest: ScriptResourceManifest, artifacts: WorkArtifactStore, installation: string): InstalledScript[] {
  return scriptResourceManifestSchema.parse(manifest).scripts.map(resource => {
    const action = actions.find(action => action.qualifiedName === resource.reference);
    if (!action) throw new WorkflowError("WorkDefinitionUnavailable", "Configured script is absent from the installed action catalog.", 409);
    if ((action.env ?? []).some(entry => /(?:secret|password|token|credential|api[_-]?key)/i.test(entry.name) || action.secrets?.includes(entry.name)))
      throw new WorkflowError("WorkCredentialsInvalid", "Credential values must be declared as selected vault secret names.", 409);
    const invocation = resolveActionRun(action.dir, action.run), runtimePath = binary(invocation.command);
    const files = new Map(resource.files.map(file => [file.path, realpathSync(file.source)]));
    const entry = files.get(resource.entry);
    if (!entry || new Set(resource.arguments.map(argument => argument.index)).size !== resource.arguments.length)
      throw new WorkflowError("WorkSourceManifestInvalid", "Script entry or argument mappings are invalid.", 409);
    const argv: WorkProcessProgram["argv"] = [...invocation.args];
    for (const argument of resource.arguments) {
      const original = invocation.args[argument.index], path = files.get(argument.path);
      if (!original || !path || realpathSync(argument.format === "file-url" ? fileURLToPath(original) : resolve(action.dir, original)) !== path)
        throw new WorkflowError("WorkSourceManifestInvalid", "Script argument mapping differs from its installed invocation.", 409);
      argv[argument.index] = argument.path === resource.entry ? { source: true } : { file: argument.path, format: argument.format };
    }
    if (runtimePath !== entry && !argv.some(argument => typeof argument !== "string" && "source" in argument))
      throw new WorkflowError("WorkSourceManifestInvalid", "The installed invocation does not launch its retained entry.", 409);
    const bundle = prepareProcessBundle({ artifacts, allowedRoots: resource.allowed_roots, files: resource.files });
    const retain = (path: string) => artifacts.stage(readBoundedFile(path, artifacts.maxArtifactBytes), { purpose: "source", media_type: "application/octet-stream", owner_identity: null });
    const source = retain(entry), runtime = retain(runtimePath);
    const shellPath = action.preflight || action.validate ? binary("/bin/sh") : undefined;
    const shell = shellPath ? retain(shellPath) : undefined;
    const actionDirectory = realpathSync(action.dir), actionStat = statSync(actionDirectory);
    const commandBase = shell ? { runtime: shell, ...(sealedSystemRuntime(shellPath!) ? { runtime_path: shellPath } : {}), cwd: { path: actionDirectory, device: actionStat.dev, inode: actionStat.ino } } : undefined;
    const commands = commandBase ? {
      ...(action.preflight ? { preflight: { ...commandBase, command: action.preflight.command, files_exist: [], timeout_ms: (action.preflight.timeout ?? 15) * 1000, ...(action.preflight.hint ? { hint: action.preflight.hint } : {}) } } : {}),
      ...(action.validate ? { postcondition: { ...commandBase, ...(action.validate.command ? { command: action.validate.command } : {}), files_exist: action.validate.files_exist ?? [], timeout_ms: (action.validate.timeout ?? 60) * 1000 } } : {}),
    } : undefined;
    if (bundle.files.find(file => file.path === resource.entry)?.digest !== source.digest)
      throw new WorkflowError("WorkSourceManifestInvalid", "Script entry changed while its source closure was captured.", 409);
    const cwd = realpathSync(invocation.cwd), directory = statSync(cwd);
    const policy = artifacts.stage(Buffer.from(JSON.stringify({ version: 1, script: resource, definition: action })), { purpose: "source", owner_identity: null, media_type: "application/vnd.barry.script-resources+json" });
    const type = `scripts:${boundFingerprint({ action, bundle: bundle.source, policy, runtime, commands, argv, cwd })}@1`;
    return { action, type, source, sources: [...new Map([source, runtime, bundle.source, policy, ...(shell ? [shell] : [])].map(ref => [ref.digest, ref])).values()], program: {
      activity_type: type, installation, source_digest: source.digest, runtime, ...(sealedSystemRuntime(runtimePath) ? { runtime_path: runtimePath } : {}),
      argv, source_name: resource.entry.split("/").at(-1)!, cwd: { path: cwd, device: directory.dev, inode: directory.ino },
      env: Object.fromEntries((action.env ?? []).map(entry => [entry.name, entry.value])), secret_names: [...new Set(action.secrets ?? [])],
      output: action.outputSchema ? "json" : "text-tail", bundle: { source: bundle.source, entry: resource.entry }, source_environment: ["BARRY_ACTION_DIR"],
      ...(commands ? { commands } : {}),
    } };
  });
}

export async function installationScripts(path: string, artifacts: WorkArtifactStore, installation: string): Promise<InstalledScript[]> {
  if (!isAbsolute(path)) throw new WorkflowError("WorkSourceManifestInvalid", "Script resource manifest requires an absolute installation path.", 409);
  const manifest = scriptResourceManifestSchema.parse(JSON.parse(readBoundedFile(path, 8 * 1024 * 1024).toString("utf8")));
  return installedScripts((await listAllActions(await loadAllBags())).filter(isScriptAction), manifest, artifacts, installation);
}

/** Rebuild registrations from accepted immutable plans, so an installation
 * refresh cannot strand queued old versions or substitute current code. */
export function retainedScriptActivities(path: string, artifacts: WorkArtifactStore): Record<string, string> {
  const db = new SqliteDatabase(path), result: Record<string, string> = {};
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_work_admissions'").get()) return result;
    for (const row of db.prepare("SELECT w.record FROM workflow_work_admissions w JOIN workflow_runs r ON r.id=w.run_id WHERE r.status IN ('running','blocked')").iterate()) {
      const work = workAdmissionSchema.parse(JSON.parse(String(row.record))), program = work.plan.process_program;
      if (!program || !(program.activity_type.startsWith("scripts:") || program.activity_type.startsWith("script_"))) continue;
      for (const source of work.plan.source_closure) artifacts.verify(source);
      if (result[program.activity_type] && result[program.activity_type] !== program.source_digest) throw new Error("conflicting retained script registration");
      result[program.activity_type] = program.source_digest;
    }
    return result;
  } finally { db.close(); }
}

/** Archive every accepted version, including terminal versions still pinned by
 * owner history. They need not all be advertised for fresh execution. */
export function retainedScriptArchive(path: string, artifacts: WorkArtifactStore): WorkflowArtifact[] {
  const db = new SqliteDatabase(path), result = new Map<string, WorkflowArtifact>();
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_work_admissions'").get()) return [];
    for (const row of db.prepare("SELECT record FROM workflow_work_admissions").iterate()) {
      const work = workAdmissionSchema.parse(JSON.parse(String(row.record))), program = work.plan.process_program;
      if (!program || !(program.activity_type.startsWith("scripts:") || program.activity_type.startsWith("script_"))) continue;
      const source = work.plan.source_closure.find(ref => ref.digest === program.source_digest && ref.purpose === "source");
      if (!source) throw new Error("missing retained script source");
      artifacts.verify(source);
      result.set(program.activity_type, { type: program.activity_type, version: "activity", digest: source.digest, path: artifacts.path(source), abi: artifactAbi, kind: "program", bytes: source.bytes });
    }
    return [...result.values()];
  } finally { db.close(); }
}
