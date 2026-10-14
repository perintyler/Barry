import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { identifier } from "./types.js";
import { readBoundedFile } from "./read-bounded.js";

export const artifactAbi = "barry-workflows-v2-node26";
export interface WorkflowArtifact { path: string; digest: string; type: string; version: string; abi: typeof artifactAbi }
const readArtifact = (path: string) => readBoundedFile(path, 2_097_152);
/** Artifacts are pre-bundled ESM, without runtime imports. No application code is imported here. */
export function inspectArtifact(path: string, type: string, version: string, workflow = true): WorkflowArtifact {
  if (!isAbsolute(path)) throw new Error("artifact path must be absolute");
  path = realpathSync(path);
  const bytes = readArtifact(path);
  if (bytes.length > 2_097_152) throw new Error("artifact exceeds 2 MiB");
  const source = bytes.toString("utf8");
  // Defense for trusted authors, not a parser/security sandbox. Imports must be bundled beforehand.
  if (/\bimport\s*(?:[("'*{]|[\w$]+\s+from)|\bexport\s+[^;]*\bfrom\s*["']|\brequire\s*\(/m.test(source)) throw new Error("artifact must be a self-contained ESM bundle");
  if (workflow && /\b(?:Date|process|fetch|globalThis|eval|Function|WebSocket|crypto|performance|Intl|setTimeout|setInterval|queueMicrotask|WeakRef|FinalizationRegistry)\b|Math\s*(?:\.\s*random|\[\s*["']random["']\s*\])/.test(source)) throw new Error("workflow artifact uses a forbidden ambient API");
  return { path, digest: createHash("sha256").update(bytes).digest("hex"), type: identifier.parse(type), version: identifier.parse(version), abi: artifactAbi };
}
export function verifyArtifact(artifact: WorkflowArtifact): Buffer {
  if (artifact.abi !== artifactAbi || process.versions.node.split(".")[0] !== "26") throw new Error("unsupported artifact runtime ABI");
  const bytes = readArtifact(artifact.path);
  if (bytes.length > 2_097_152 || createHash("sha256").update(bytes).digest("hex") !== artifact.digest) throw new Error("artifact digest mismatch");
  return bytes;
}
