import type { StoreSnapshotAdapter } from "@barry-rocks/sdk/stores";
import { openLocalArtifactStore } from "./store.js";

export const captureSnapshot: StoreSnapshotAdapter = async (ref, filepath, destination) => {
  const store = await openLocalArtifactStore({ ...ref, filepath, owned_by: "identity", engine: "sqlite" });
  try { return await store.snapshot(destination); } finally { store.close(); }
};
