import { createHash } from "node:crypto";
import { fstatSync, lstatSync, readSync } from "node:fs";
import { ArtifactError } from "../types.js";
import type { ArtifactBlob } from "../blobs.js";

export function verifyArtifactBlobDescriptor(file: number, blob: ArtifactBlob, path: string): void {
  const before = fstatSync(file), hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  if (!before.isFile() || before.size !== blob.size) throw new ArtifactError("unavailable");
  let position = 0;
  while (position < blob.size) {
    const count = readSync(file, buffer, 0, Math.min(buffer.length, blob.size - position), position);
    if (!count) throw new ArtifactError("unavailable");
    hash.update(buffer.subarray(0, count)); position += count;
  }
  const after = fstatSync(file), destination = lstatSync(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || destination.isSymbolicLink()
    || destination.ino !== before.ino || destination.dev !== before.dev || hash.digest("hex") !== blob.sha256) throw new ArtifactError("unavailable");
}
