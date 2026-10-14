import { Barry } from "@barry-rocks/sdk";
import "@barry-rocks/sdk/stores";
import { createHash, randomUUID } from "node:crypto";
import { openLocalArtifactStore, type LocalArtifactStore } from "./local/store.js";
import { createArtifactCore, type ArtifactAccess } from "./core.js";
import { createArtifactCreator, type CreateArtifactInput } from "./create.js";
import type {
  ArtifactCursor,
  ArtifactList,
  ArtifactRecord,
  CreateShareInput,
  ShareMetadata,
  UpdateArtifactMetadata,
  UpdateShareInput,
} from "./types.js";
import { hashShareToken, hashSharePassword } from "./local/shares.js";
import { captureSnapshot } from "./local/snapshot-adapter.js";

const artifacts = Barry.bag("artifacts");

export async function withArtifactStore<T>(operation: (store: LocalArtifactStore) => Promise<T>): Promise<T> {
  const store = await openLocalArtifactStore(artifacts.store());
  try { return await operation(store); } finally { store.close(); }
}
export { openLocalArtifactStore, type LocalArtifactStore } from "./local/store.js";
export type { CreateArtifactInput } from "./create.js";

export function registerArtifactSnapshots(registry: import("@barry-rocks/sdk/stores").StoreRegistry): void {
  registry.registerSnapshotAdapter("artifacts", "default", captureSnapshot);
}

function getCore(store: LocalArtifactStore, options?: { actorId?: number; credentialId?: string }) {
  const identityId = store.repository.identityId;
  const actorId = options?.actorId ?? 1;
  const credentialId = options?.credentialId ?? "local-caller";
  const access: ArtifactAccess = {
    async authorize() {
      return { actorId, identityId, credentialId };
    },
  };
  return createArtifactCore({
    repository: store.repository,
    access,
    blobs: store.blobs,
    now: () => new Date().toISOString(),
    newId: randomUUID,
    hashToken: hashShareToken,
    hashPassword: hashSharePassword,
    randomBytes: (count) => {
      const arr = new Uint8Array(count);
      globalThis.crypto.getRandomValues(arr);
      return arr;
    },
  });
}

export async function createArtifact(
  input: CreateArtifactInput,
  source: AsyncIterable<Uint8Array>,
  options?: {
    signal?: AbortSignal;
    actorId?: number;
    credentialId?: string;
    authorizeSession?: (sessionId: string, grant: import("./types.js").ArtifactGrant, signal?: AbortSignal) => Promise<void>;
  },
): Promise<ArtifactRecord> {
  return withArtifactStore(async store => {
    const identityId = store.repository.identityId;
    const actorId = options?.actorId ?? 1;
    const credentialId = options?.credentialId ?? "local-caller";
    const access: ArtifactAccess = {
      async authorize() {
        return { actorId, identityId, credentialId };
      },
    };
    const creator = createArtifactCreator({
      repository: store.repository,
      blobs: store.blobs,
      access,
      authorizeSession: options?.authorizeSession ?? (async () => {}),
      now: () => new Date().toISOString(),
      newId: randomUUID,
      hashText: async text => createHash("sha256").update(text).digest("hex"),
    });
    return creator.create(input, source, options?.signal);
  });
}

export async function readArtifact(
  id: string,
  options?: { signal?: AbortSignal; actorId?: number; credentialId?: string },
): Promise<ArtifactRecord> {
  return withArtifactStore(async store => getCore(store, options).read(id, options?.signal));
}

export async function listArtifacts(
  input?: ArtifactList,
  options?: { signal?: AbortSignal; actorId?: number; credentialId?: string },
): Promise<{ items: readonly ArtifactRecord[]; nextCursor: ArtifactCursor | null }> {
  return withArtifactStore(async store => getCore(store, options).list(input ?? { limit: 50 }, options?.signal));
}

export async function searchArtifacts(
  query: string,
  input?: Omit<ArtifactList, "query">,
  options?: { signal?: AbortSignal; actorId?: number; credentialId?: string },
): Promise<{ items: readonly ArtifactRecord[]; nextCursor: ArtifactCursor | null }> {
  return withArtifactStore(async store => getCore(store, options).list({ ...input, query, limit: input?.limit ?? 50 }, options?.signal));
}

export async function updateArtifactMetadata(
  input: UpdateArtifactMetadata,
  options?: { signal?: AbortSignal; actorId?: number; credentialId?: string },
): Promise<ArtifactRecord> {
  return withArtifactStore(async store => getCore(store, options).updateMetadata(input, options?.signal));
}

export async function streamArtifactContent(
  id: string,
  options?: { signal?: AbortSignal; actorId?: number; credentialId?: string },
): Promise<{ record: ArtifactRecord; stream: AsyncIterable<Uint8Array> }> {
  return withArtifactStore(async store => getCore(store, options).streamContent(id, options?.signal));
}

export async function listArtifactShares(
  artifactId: string,
  options?: { signal?: AbortSignal; actorId?: number; credentialId?: string },
): Promise<readonly ShareMetadata[]> {
  return withArtifactStore(async store => getCore(store, options).listShares(artifactId, options?.signal));
}

export async function createArtifactShare(
  input: CreateShareInput,
  options?: { signal?: AbortSignal; actorId?: number; credentialId?: string },
): Promise<{ metadata: ShareMetadata; token: string; identityId: string }> {
  return withArtifactStore(async store => ({
    ...await getCore(store, options).createShare(input, options?.signal),
    identityId: store.repository.identityId,
  }));
}

export async function updateArtifactShare(
  input: UpdateShareInput,
  options?: { signal?: AbortSignal; actorId?: number; credentialId?: string },
): Promise<ShareMetadata> {
  return withArtifactStore(async store => getCore(store, options).updateShare(input, options?.signal));
}

export async function revokeArtifactShare(
  shareId: string,
  options?: { signal?: AbortSignal; actorId?: number; credentialId?: string },
): Promise<void> {
  return withArtifactStore(async store => getCore(store, options).revokeShare(shareId, options?.signal));
}

export { publishHandoff, type PublishHandoffInput, type PublishHandoffResult } from "./handoff.js";

