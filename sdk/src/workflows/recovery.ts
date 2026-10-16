import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, isAbsolute } from "node:path";
import type { WorkflowArtifact, artifactAbi } from "./artifacts.js";

import type { WorkRecoveryInventory, WorkRecoveryManifest } from "./work-recovery.js";
import type { WorkArtifactBundle } from "./work-artifact-recovery.js";

export interface SnapshotManifest { workRecovery?: WorkRecoveryManifest; workArtifacts?: WorkArtifactBundle; format: 1; abi: typeof artifactAbi; owner: string; epoch: string; createdAt: string; databaseDigest: string; artifacts: { type: string; version: string; digest: string; file: string; kind?: "program"; bytes?: number }[]; sessionDependencies?: { kind: "references-only"; file: "session-dependencies.jsonl"; digest: string; bytes: number; entries: number } }
function maintenance(request: object): Promise<SnapshotManifest> {
  return new Promise((resolveResult, reject) => {
    const source = import.meta.url.endsWith(".ts");
    const entry = fileURLToPath(new URL(source ? "./recovery-child.ts" : "./recovery-child.js", import.meta.url));
    const child = spawn(process.execPath, [...(source ? ["--import", "tsx"] : []), entry], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    const coordinated = ("workRecovery" in request && request.workRecovery !== undefined) || ("oldExecutorsFenced" in request && request.oldExecutorsFenced === true);
    const timer = setTimeout(() => child.kill("SIGKILL"), coordinated ? 600_000 : 60_000);
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); if (output.length > 1_048_576) child.kill("SIGKILL"); });
    child.stderr.on("data", (data: Buffer) => { error = (error + data.toString()).slice(-4096); });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.once("close", code => { clearTimeout(timer); if (code !== 0) reject(new Error(`workflow maintenance failed: ${error}`)); else { try { resolveResult(JSON.parse(output) as SnapshotManifest); } catch { reject(new Error("invalid maintenance result")); } } });
    child.stdin.end(JSON.stringify(request));
  });
}
export function snapshotWorkflows(path: string, destination: string, owner: string, artifacts: WorkflowArtifact[], workArtifactRoot?: string, workRecovery?: WorkRecoveryInventory): Promise<SnapshotManifest> {
  if (!isAbsolute(path) || !isAbsolute(destination) || resolve(path) === resolve(destination)) throw new Error("snapshot requires separate absolute source and destination paths");
  return maintenance({ operation: "snapshot", path, destination, owner, artifacts, workArtifactRoot, workRecovery });
}
/** Restore only into a new isolated directory. Caller must fence old owners before activating it. */
export function restoreWorkflows(snapshot: string, destination: string, owner: string, oldOwnerFenced: boolean, oldExecutorsFenced = false): Promise<SnapshotManifest> {
  if (!oldOwnerFenced) throw new Error("old owner and effect path must be fenced before restore");
  if (!isAbsolute(snapshot) || !isAbsolute(destination) || resolve(snapshot) === resolve(destination)) throw new Error("restore requires a new absolute destination");
  return maintenance({ operation: "restore", snapshot, destination, owner, oldExecutorsFenced });
}
