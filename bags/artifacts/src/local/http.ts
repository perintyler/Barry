import { Barry } from "@barry-rocks/sdk";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readArtifact, listArtifacts, updateArtifactMetadata, streamArtifactContent,
  listArtifactShares, createArtifactShare, updateArtifactShare, revokeArtifactShare,
} from "../index.js";
import { ArtifactError, IdentityIdSchema } from "../types.js";
import type { ArtifactCore } from "../core.js";
import { createArtifactHttpHandler, type ArtifactHttpPrincipal } from "../http/router.js";
import { openReadOnlyArtifactStore } from "./store.js";
import { hashShareToken, verifySharePassword } from "./shares.js";

export function createLocalArtifactHttpHandler({ root, now }: { root?: string; now?: () => string } = {}) {
  const manifest = parseManifest(fileURLToPath(new URL("../../", import.meta.url)));
  if (!manifest?.stores) throw new Error("Artifacts store declaration missing");
  const stores = manifest.stores;
  const inContext = <T>(identity: string, operation: () => T) =>
    withStoreContext({ identity, root, bags: { artifacts: { stores } } }, operation);
  // A path names a store only when that identity's directory exists under exactly its name.
  // Store paths refuse "..", and a case-insensitive disk would open tester's store for TESTER,
  // which a public request could then initialize as TESTER's.
  const bindingFor = (identity: string) => {
    if (!IdentityIdSchema.safeParse(identity).success || identity.includes("..")) return undefined;
    const binding = inContext(identity, () => Barry.bag("artifacts").store());
    if (!binding.filepath || !existsSync(binding.filepath)) return undefined;
    const directory = dirname(dirname(binding.filepath));
    return basename(directory) === identity && readdirSync(dirname(directory)).includes(identity) ? binding : undefined;
  };
  const getCore = (identity: string, principal: ArtifactHttpPrincipal): ArtifactCore => {
    const call = <T>(operation: () => Promise<T>): Promise<T> => {
      if (!bindingFor(identity)) return Promise.reject(new ArtifactError("not_found"));
      return inContext(identity, operation);
    };
    const options = (signal?: AbortSignal) => ({ signal, actorId: principal.actorId, credentialId: principal.credentialId });
    return {
      read: (id, signal) => call(() => readArtifact(id, options(signal))),
      list: (input, signal) => call(() => listArtifacts(input, options(signal))),
      updateMetadata: (input, signal) => call(() => updateArtifactMetadata(input, options(signal))),
      streamContent: (id, signal) => call(() => streamArtifactContent(id, options(signal))),
      listShares: (id, signal) => call(() => listArtifactShares(id, options(signal))),
      createShare: (input, signal) => call(() => createArtifactShare(input, options(signal))),
      updateShare: (input, signal) => call(() => updateArtifactShare(input, options(signal))),
      revokeShare: (id, signal) => call(() => revokeArtifactShare(id, options(signal))),
    };
  };
  const callbacks = {
    getCore, now, hashToken: hashShareToken, verifyPassword: verifySharePassword,
    async getShareByTokenHash(hash: string, identity: string) {
      const binding = bindingFor(identity);
      if (!binding) return undefined;
      try {
        const store = await openReadOnlyArtifactStore(binding);
        try {
          const share = await store.repository.getShareByTokenHash?.(hash);
          return share ? { identityId: store.identityId, share } : undefined;
        } finally { store.close(); }
      } catch (error) {
        if (error instanceof ArtifactError && error.code === "not_found") return undefined;
        throw error;
      }
    },
    async getShareArtifactContent(identity: string, id: string, { metadataOnly = false, signal }: { metadataOnly?: boolean; signal?: AbortSignal } = {}) {
      const binding = bindingFor(identity);
      if (!binding) return undefined;
      try {
        const store = await openReadOnlyArtifactStore(binding);
        try {
          const record = await store.repository.get(id);
          if (!record || record.identityId !== identity) return undefined;
          return {
            record,
            stream: metadataOnly ? (async function* () {})() : await store.blobs.stream(record.content, signal),
          };
        } finally { store.close(); }
      } catch (error) {
        if (error instanceof ArtifactError && error.code === "not_found") return undefined;
        throw error;
      }
    },
  };
  const owner = createArtifactHttpHandler({
    ...callbacks,
    authenticator: {
      async authenticate(request) {
        const identityId = new URL(request.url).pathname.split("/")[4];
        return { actorId: 1, identityId, credentialId: "owner", scopes: ["artifacts:*"] };
      },
    },
  });
  const publicHandler = createArtifactHttpHandler({
    ...callbacks, authenticator: { async authenticate() { return null; } },
  });
  return async (request: Request, caller: { owner: boolean }): Promise<Response> => {
    try { return await (caller.owner ? owner : publicHandler)(request); }
    catch (error) {
      const unavailable = error instanceof ArtifactError && error.code === "unavailable";
      return Response.json({ error: {
        code: unavailable ? "unavailable" : "internal_error",
        message: unavailable ? "Artifact service unavailable" : "Artifact service error",
      } }, { status: unavailable ? 503 : 500, headers: { "Cache-Control": "no-store" } });
    }
  };
}
