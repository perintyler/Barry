import {
  ArtifactError, ArtifactGrantSchema, ArtifactIdSchema, ArtifactListSchema, ArtifactMetadataSchema,
  ArtifactRecordSchema, CreateShareInputSchema, ShareGrantRecordSchema, ShareIdSchema, ShareMetadataSchema,
  TimestampSchema, UpdateArtifactMetadataSchema, UpdateShareInputSchema,
  type ArtifactGrant, type ArtifactList, type ArtifactMetadata, type ArtifactOperation, type ArtifactRecord,
  type CreateShareInput, type ShareGrantRecord, type ShareMetadata, type UpdateArtifactMetadata, type UpdateShareInput,
} from "./types.js";
import type { ArtifactBlobStore } from "./blobs.js";

export interface ArtifactTransaction {
  get(id: string): ArtifactRecord | undefined;
  replaceMetadata(id: string, expectedRevision: number, metadata: ArtifactMetadata): boolean;
  getShare?(shareId: string): ShareGrantRecord | undefined;
  createShare?(share: ShareGrantRecord): void;
  updateShare?(shareId: string, expectedRevision: number, update: Partial<ShareGrantRecord> & { revision: number; updatedAt: string }): boolean;
  revokeShare?(shareId: string): boolean;
}
export interface ArtifactRepository {
  readonly identityId: string;
  get(id: string): Promise<ArtifactRecord | undefined>;
  list(input: ArtifactList): Promise<readonly ArtifactRecord[]>;
  // Keeping the callback synchronous prevents acknowledgment before the catalog commits.
  transaction<T>(operation: (transaction: ArtifactTransaction) => T): T;
  getShare?(shareId: string): Promise<ShareGrantRecord | undefined>;
  getShareByTokenHash?(tokenHash: string): Promise<ShareGrantRecord | undefined>;
  listShares?(artifactId: string): Promise<readonly ShareGrantRecord[]>;
}
export interface ArtifactAccess {
  authorize(operation: ArtifactOperation, signal?: AbortSignal): Promise<ArtifactGrant>;
}
interface ArtifactCoreOptions {
  repository: ArtifactRepository;
  access: ArtifactAccess;
  blobs?: ArtifactBlobStore;
  now: () => string;
  newId?: () => string;
  hashToken?: (token: string) => Promise<string>;
  hashPassword?: (password: string, salt: string) => Promise<string>;
  randomBytes?: (length: number) => Uint8Array;
}

export function createArtifactCore({ repository, access, blobs, now, newId, hashToken, hashPassword, randomBytes }: ArtifactCoreOptions) {
  const authorize = async (operation: ArtifactOperation, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const grant = ArtifactGrantSchema.parse(await access.authorize(operation, signal));
    signal?.throwIfAborted();
    if (grant.identityId !== repository.identityId) throw new ArtifactError("forbidden");
    return grant;
  };
  const record = (value: ArtifactRecord | undefined) => {
    if (!value) throw new ArtifactError("not_found");
    const parsed = ArtifactRecordSchema.parse(value);
    if (parsed.identityId !== repository.identityId) throw new ArtifactError("forbidden");
    return parsed;
  };
  return {
    async read(id: string, signal?: AbortSignal): Promise<ArtifactRecord> {
      ArtifactIdSchema.parse(id);
      const original = await authorize("artifacts:read", signal);
      const result = record(await repository.get(id));
      const current = await authorize("artifacts:read", signal);
      if (current.actorId !== original.actorId || current.credentialId !== original.credentialId) throw new ArtifactError("forbidden");
      return result;
    },
    async list(input: ArtifactList, signal?: AbortSignal) {
      const filters = ArtifactListSchema.parse(input);
      const original = await authorize("artifacts:read", signal);
      const artifacts = (await repository.list(filters)).map(record);
      const current = await authorize("artifacts:read", signal);
      if (current.actorId !== original.actorId || current.credentialId !== original.credentialId) throw new ArtifactError("forbidden");
      const last = artifacts.at(-1);
      return Object.freeze({
        items: Object.freeze(artifacts),
        nextCursor: artifacts.length === filters.limit && last
          ? Object.freeze({ createdAt: last.content.createdAt, id: last.id }) : null,
      });
    },
    async updateMetadata(input: UpdateArtifactMetadata, signal?: AbortSignal): Promise<ArtifactRecord> {
      const update = UpdateArtifactMetadataSchema.parse(input);
      const original = await authorize("artifacts:write", signal);
      const current = await authorize("artifacts:write", signal);
      if (current.actorId !== original.actorId || current.credentialId !== original.credentialId) throw new ArtifactError("forbidden");
      return repository.transaction(transaction => {
        signal?.throwIfAborted();
        const existing = record(transaction.get(update.id));
        if (existing.metadata.revision !== update.expectedRevision) throw new ArtifactError("conflict");
        const metadata = ArtifactMetadataSchema.parse({
          title: update.title === undefined ? existing.metadata.title : update.title,
          tags: update.tags ?? existing.metadata.tags,
          revision: existing.metadata.revision + 1, updatedAt: TimestampSchema.parse(now()),
        });
        if (!transaction.replaceMetadata(update.id, update.expectedRevision, metadata)) throw new ArtifactError("conflict");
        return ArtifactRecordSchema.parse({ ...existing, metadata });
      });
    },
    async streamContent(id: string, signal?: AbortSignal): Promise<{ record: ArtifactRecord; stream: AsyncIterable<Uint8Array> }> {
      ArtifactIdSchema.parse(id);
      if (!blobs) throw new ArtifactError("unavailable");
      const original = await authorize("artifacts:read", signal);
      const artifact = record(await repository.get(id));
      const current = await authorize("artifacts:read", signal);
      if (current.actorId !== original.actorId || current.credentialId !== original.credentialId) throw new ArtifactError("forbidden");
      const stream = await blobs.stream(artifact.content, signal);
      return { record: artifact, stream };
    },
    async listShares(artifactId: string, signal?: AbortSignal): Promise<readonly ShareMetadata[]> {
      ArtifactIdSchema.parse(artifactId);
      if (!repository.listShares) throw new ArtifactError("unavailable");
      const original = await authorize("artifacts:read", signal);
      const artifact = record(await repository.get(artifactId));
      const shares = await repository.listShares(artifact.id);
      const current = await authorize("artifacts:read", signal);
      if (current.actorId !== original.actorId || current.credentialId !== original.credentialId) throw new ArtifactError("forbidden");
      return Object.freeze(shares.map(s => ShareMetadataSchema.parse({
        id: s.id, artifactId: s.artifactId, expiresAt: s.expiresAt, revoked: s.revoked,
        hasPassword: Boolean(s.passwordHash), revision: s.revision, createdAt: s.createdAt, updatedAt: s.updatedAt,
      })));
    },
    async createShare(input: CreateShareInput, signal?: AbortSignal): Promise<{ metadata: ShareMetadata; token: string }> {
      const shareInput = CreateShareInputSchema.parse(input);
      if (!repository.transaction || !newId || !hashToken) throw new ArtifactError("unavailable");
      const original = await authorize("artifacts:share", signal);
      const artifact = record(await repository.get(shareInput.artifactId));
      const getRandomHex = (bytesCount: number): string => {
        if (randomBytes) {
          const arr = randomBytes(bytesCount);
          return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
        }
        if (typeof globalThis.crypto?.getRandomValues === "function") {
          const arr = new Uint8Array(bytesCount);
          globalThis.crypto.getRandomValues(arr);
          return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
        }
        throw new ArtifactError("unavailable");
      };
      const token = getRandomHex(32);
      const tokenHash = await hashToken(token);
      let passwordSalt: string | null = null, passwordHash: string | null = null;
      if (shareInput.password) {
        if (!hashPassword) throw new ArtifactError("unavailable");
        passwordSalt = getRandomHex(16);
        passwordHash = await hashPassword(shareInput.password, passwordSalt);
      }
      const currentTime = TimestampSchema.parse(now());
      const expiresAt = new Date(Date.parse(currentTime) + shareInput.expiresInSeconds * 1000).toISOString();
      const shareRecord = ShareGrantRecordSchema.parse({
        id: ShareIdSchema.parse(newId()),
        artifactId: artifact.id,
        identityId: repository.identityId,
        tokenHash,
        expiresAt,
        revoked: false,
        passwordSalt,
        passwordHash,
        revision: 1,
        createdAt: currentTime,
        updatedAt: currentTime,
      });
      const current = await authorize("artifacts:share", signal);
      if (current.actorId !== original.actorId || current.credentialId !== original.credentialId) throw new ArtifactError("forbidden");
      repository.transaction(t => {
        signal?.throwIfAborted();
        if (!t.createShare) throw new ArtifactError("unavailable");
        t.createShare(shareRecord);
      });
      const metadata = ShareMetadataSchema.parse({
        id: shareRecord.id, artifactId: shareRecord.artifactId, expiresAt: shareRecord.expiresAt,
        revoked: shareRecord.revoked, hasPassword: Boolean(shareRecord.passwordHash), revision: shareRecord.revision,
        createdAt: shareRecord.createdAt, updatedAt: shareRecord.updatedAt,
      });
      return { metadata, token };
    },
    async updateShare(input: UpdateShareInput, signal?: AbortSignal): Promise<ShareMetadata> {
      const update = UpdateShareInputSchema.parse(input);
      if (!repository.transaction) throw new ArtifactError("unavailable");
      const original = await authorize("artifacts:share", signal);
      let salt: string | null = null, passHash: string | null = null;
      if (update.password) {
        if (!hashPassword) throw new ArtifactError("unavailable");
        const getRandomHex = (bytesCount: number): string => {
          if (randomBytes) {
            const arr = randomBytes(bytesCount);
            return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
          }
          if (typeof globalThis.crypto?.getRandomValues === "function") {
            const arr = new Uint8Array(bytesCount);
            globalThis.crypto.getRandomValues(arr);
            return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
          }
          throw new ArtifactError("unavailable");
        };
        salt = getRandomHex(16);
        passHash = await hashPassword(update.password, salt);
      }
      const currentTime = TimestampSchema.parse(now());
      const current = await authorize("artifacts:share", signal);
      if (current.actorId !== original.actorId || current.credentialId !== original.credentialId) throw new ArtifactError("forbidden");
      return repository.transaction(t => {
        signal?.throwIfAborted();
        if (!t.updateShare) throw new ArtifactError("unavailable");
        const existing = t.getShare ? t.getShare(update.shareId) : undefined;
        if (!existing) throw new ArtifactError("not_found");
        const nextExpires = update.expiresInSeconds !== undefined ? new Date(Date.parse(currentTime) + update.expiresInSeconds * 1000).toISOString() : undefined;
        const changes: Partial<ShareGrantRecord> & { revision: number; updatedAt: string } = {
          revision: update.expectedRevision + 1,
          updatedAt: currentTime,
          ...(update.revoked !== undefined ? { revoked: update.revoked } : {}),
          ...(nextExpires !== undefined ? { expiresAt: nextExpires } : {}),
          ...(update.password === null ? { passwordSalt: null, passwordHash: null } : update.password ? { passwordSalt: salt, passwordHash: passHash } : {}),
        };
        if (!t.updateShare(update.shareId, update.expectedRevision, changes)) throw new ArtifactError("conflict");
        return ShareMetadataSchema.parse({
          id: update.shareId,
          artifactId: existing.artifactId,
          expiresAt: changes.expiresAt ?? existing.expiresAt,
          revoked: changes.revoked ?? existing.revoked,
          hasPassword: Boolean(changes.passwordHash ?? existing.passwordHash),
          revision: changes.revision,
          createdAt: existing.createdAt,
          updatedAt: changes.updatedAt,
        });
      });
    },
    async revokeShare(shareId: string, signal?: AbortSignal): Promise<void> {
      ShareIdSchema.parse(shareId);
      const original = await authorize("artifacts:share", signal);
      const current = await authorize("artifacts:share", signal);
      if (current.actorId !== original.actorId || current.credentialId !== original.credentialId) throw new ArtifactError("forbidden");
      repository.transaction(t => {
        signal?.throwIfAborted();
        if (!t.revokeShare) throw new ArtifactError("unavailable");
        if (!t.revokeShare(shareId)) throw new ArtifactError("not_found");
      });
    },
  };
}

export type ArtifactCore = ReturnType<typeof createArtifactCore>;

