import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WorkflowOwner } from "./workflow-owner.js";
import { artifactAbi, verifyArtifact, type WorkflowArtifact } from "./artifacts.js";
import { snapshotWorkflows, restoreWorkflows } from "./recovery.js";

it("archives and restores bounded large raw program artifacts without widening module limits", async () => {
  const root = mkdtempSync(join(tmpdir(), "program-archive-")), path = join(root, "owner.db"), program = join(root, "large-program");
  const bytes = Buffer.alloc(3 * 1024 * 1024, 0x61); writeFileSync(program, bytes);
  const artifact: WorkflowArtifact = { path: program, type: "scripts:large@1", version: "activity", digest: createHash("sha256").update(bytes).digest("hex"), abi: artifactAbi, kind: "program", bytes: bytes.length };
  const owner = new WorkflowOwner({ id: "owner", path, activityArtifacts: { [artifact.type]: artifact.digest } }); owner.close();
  try {
    expect(() => verifyArtifact({ ...artifact, kind: undefined })).toThrow();
    expect(() => verifyArtifact({ ...artifact, bytes: bytes.length - 1 })).toThrow();
    const backup = join(root, "backup"), restored = join(root, "restored");
    const manifest = await snapshotWorkflows(path, backup, "owner", [artifact]);
    expect(manifest.artifacts[0]).toMatchObject({ kind: "program", bytes: bytes.length });
    await restoreWorkflows(backup, restored, "owner", true);
    expect(verifyArtifact({ ...artifact, path: join(restored, manifest.artifacts[0]!.file) })).toEqual(bytes);
    const metadata = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")); metadata.artifacts[0].bytes++;
    writeFileSync(join(backup, "manifest.json"), JSON.stringify(metadata));
    await expect(restoreWorkflows(backup, join(root, "tampered"), "owner", true)).rejects.toThrow(/metadata mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
