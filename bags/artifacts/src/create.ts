import { z } from "zod";
import { ArtifactContentSchema, ArtifactError, ArtifactGrantSchema, ArtifactIdSchema, ArtifactRecordSchema, TagsSchema, TimestampSchema, type ArtifactGrant, type ArtifactRecord } from "./types.js";
import { MAX_ARTIFACT_BYTES, type ArtifactBlob, type ArtifactBlobStore } from "./blobs.js";
import type { ArtifactAccess, ArtifactRepository } from "./core.js";

const content = ArtifactContentSchema.unwrap().shape;
export const CreateArtifactSchema = z.strictObject({
  filename: content.filename, mimeType: content.mimeType, kind: content.kind,
  sessionId: content.sessionId.default(null), derivedFrom: content.derivedFrom.default(null),
  title: z.string().min(1).max(500).nullable().default(null), tags: TagsSchema.default([]),
  idempotencyKey: z.string().min(1).max(200),
});
export type CreateArtifactInput = z.input<typeof CreateArtifactSchema>;
export const ArtifactUploadIntentSchema = z.strictObject({
  id: ArtifactIdSchema, createdAt: TimestampSchema, expiresAt: TimestampSchema,
}).readonly();
export type ArtifactUploadIntent = z.infer<typeof ArtifactUploadIntentSchema>;
export interface ArtifactCreationRepository extends ArtifactRepository {
  beginIntent(intent: ArtifactUploadIntent): void;
  stageIntent(id: string, blob: ArtifactBlob, now: string): void;
  publishIntent(id: string, now: string): void;
  failIntent(id: string): void;
  commitArtifact(input: { intentId: string; record: ArtifactRecord; idempotencyKey: string; fingerprint: string; now: string; checkActive: () => void }): ArtifactRecord;
}
function withCancellation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason instanceof Error ? signal.reason : new ArtifactError("unavailable")); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error instanceof Error ? error : new Error("Artifact operation failed", { cause: error })); },
    );
    if (signal.aborted) abort();
  });
}
interface ArtifactCreatorOptions {
  repository: ArtifactCreationRepository; blobs: ArtifactBlobStore; access: ArtifactAccess;
  authorizeSession?: (sessionId: string, grant: ArtifactGrant, signal: AbortSignal) => Promise<void>;
  now: () => string; newId: () => string; hashText: (text: string) => Promise<string>;
}
export function createArtifactCreator({ repository, blobs, access, now, newId, hashText, authorizeSession }: ArtifactCreatorOptions) {
  return {
    async create(input: CreateArtifactInput, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<ArtifactRecord> {
      const request = CreateArtifactSchema.parse(input), deadline = new AbortController();
      const deadlineAt = performance.now() + 60_000;
      const checkActive = () => {
        deadline.signal.throwIfAborted();
        if (performance.now() >= deadlineAt) throw new ArtifactError("unavailable");
      };
      const abort = () => deadline.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => deadline.abort(new ArtifactError("unavailable")), 60_000);
      const authorize = async () => {
        deadline.signal.throwIfAborted();
        const grant = ArtifactGrantSchema.parse(await withCancellation(() => access.authorize("artifacts:write", deadline.signal), deadline.signal));
        deadline.signal.throwIfAborted();
        if (grant.identityId !== repository.identityId) throw new ArtifactError("forbidden");
        return grant;
      };
      let intentId: string | undefined, committed = false, intentStarted = false;
      try {
        const original = await authorize(), createdAt = TimestampSchema.parse(now());
        const revalidate = async () => {
          const current = await authorize();
          if (current.actorId !== original.actorId || current.credentialId !== original.credentialId) throw new ArtifactError("forbidden");
        };

        if (request.sessionId && !authorizeSession) throw new ArtifactError("forbidden");
        const validateProvenance = async () => {
          if (request.sessionId) await withCancellation(() => authorizeSession!(request.sessionId!, original, deadline.signal), deadline.signal);
          if (request.derivedFrom) {
            const parent = await withCancellation(() => repository.get(request.derivedFrom!), deadline.signal);
            if (!parent) throw new ArtifactError("not_found");
            if (ArtifactRecordSchema.parse(parent).identityId !== repository.identityId) throw new ArtifactError("forbidden");
          }
        };
        await validateProvenance();
        await revalidate();
        intentId = ArtifactIdSchema.parse(newId());
        repository.beginIntent({ id: intentId, createdAt, expiresAt: new Date(Date.parse(createdAt) + 120_000).toISOString() });
        intentStarted = true;
        const blob = await withCancellation(() => blobs.stage(intentId!, source, deadline.signal), deadline.signal);
        if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > MAX_ARTIFACT_BYTES) throw new ArtifactError("too_large");
        content.sha256.parse(blob.sha256);
        const fingerprint = content.sha256.parse(await withCancellation(() => hashText(JSON.stringify({ ...request, actorId: original.actorId, identityId: original.identityId, sha256: blob.sha256, size: blob.size })), deadline.signal));
        await revalidate();
        repository.stageIntent(intentId, blob, TimestampSchema.parse(now()));
        await withCancellation(() => blobs.publish(intentId!, blob, deadline.signal), deadline.signal);
        repository.publishIntent(intentId, TimestampSchema.parse(now()));
        await validateProvenance();
        await revalidate();
        const artifact = ArtifactRecordSchema.parse({
          id: ArtifactIdSchema.parse(newId()), identityId: repository.identityId,
          content: { filename: request.filename, mimeType: request.mimeType, kind: request.kind, ...blob, createdAt,
            creator: { actorId: original.actorId, identityId: original.identityId }, sessionId: request.sessionId, derivedFrom: request.derivedFrom },
          metadata: { title: request.title, tags: request.tags, revision: 1, updatedAt: createdAt },
        });
        deadline.signal.throwIfAborted();
        const saved = ArtifactRecordSchema.parse(repository.commitArtifact({ intentId, record: artifact, idempotencyKey: request.idempotencyKey, fingerprint, now: TimestampSchema.parse(now()), checkActive }));
        committed = true;
        return saved;
      } finally {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (intentId && intentStarted) {
          if (!committed) repository.failIntent(intentId);
          // A committed result must survive cleanup failure; the completed intent remains recoverable.
          if (committed) await blobs.discard(intentId).catch(() => undefined);
          else await blobs.discard(intentId);
        }
      }
    },
  };
}
