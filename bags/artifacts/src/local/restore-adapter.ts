import { link, lstat, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { StoreRestoreAdapter } from "@barry-rocks/sdk/stores";
import { ArtifactError } from "../types.js";
import { prepareLocalArtifactRestore } from "./restore.js";

export const prepareRestore: StoreRestoreAdapter = async (snapshot, ref, destination) => {
  if (!ref.identity || ref.bag !== "artifacts" || ref.store !== "default") throw new ArtifactError("forbidden");
  for (const path of [destination, `${destination}.blobs`]) {
    try { await lstat(path); throw new ArtifactError("unavailable"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const prepared = await prepareLocalArtifactRestore(snapshot, { node: ref.node, identity: ref.identity, directory: dirname(destination) });
  try {
    // Exclusive linking prevents replacing a catalog created after the destination check.
    await link(prepared.binding.filepath, destination);
    await rename(`${prepared.binding.filepath}.blobs`, `${destination}.blobs`);
  } finally { await rm(prepared.directory, { recursive: true, force: true }); }
};
