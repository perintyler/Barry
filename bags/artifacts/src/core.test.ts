import { expect, it } from "vitest";
import { createArtifactCore, type ArtifactRepository } from "./core.js";
import { ArtifactRecordSchema, UpdateArtifactMetadataSchema, type ArtifactGrant, type ArtifactRecord, type ShareGrantRecord } from "./types.js";
import type { ArtifactBlobStore } from "./blobs.js";

const initial = (): ArtifactRecord => ArtifactRecordSchema.parse({
  id: "artifact-1", identityId: "owned", content: { filename: "report.html", mimeType: "text/html", size: 7, sha256: "a".repeat(64), kind: "html", createdAt: "2026-10-03T00:00:00.000Z", creator: { actorId: 99, identityId: "owned" }, sessionId: null, derivedFrom: null },
  metadata: { title: null, tags: [], revision: 1, updatedAt: "2026-10-03T00:00:00.000Z" },
});
function fixture() {
  let saved = initial(), grant: ArtifactGrant = { actorId: 7, identityId: "owned", credentialId: "original" };
  let writes = 0, calls = 0;
  const repository: ArtifactRepository = {
    identityId: "owned", async get() { return saved; }, async list() { return [saved]; },
    transaction(operation) { return operation({ get: () => saved, replaceMetadata(_id, expected, metadata) {
      if (saved.metadata.revision !== expected) return false;
      saved = ArtifactRecordSchema.parse({ ...saved, metadata }); writes++; return true;
    } }); },
  };
  const core = createArtifactCore({ repository, access: { async authorize() { calls++; return grant; } }, now: () => "2026-10-03T01:00:00.000Z" });
  return { core, repository, saved: () => saved, writes: () => writes, calls: () => calls, grant(value: ArtifactGrant) { grant = value; } };
}
it("edits metadata without changing content or creator provenance", async () => {
  const f = fixture(), content = f.saved().content;
  const updated = await f.core.updateMetadata({ id: "artifact-1", expectedRevision: 1, title: "Report", tags: ["handoff"] });
  expect(updated.content).toEqual(content); expect(updated.metadata).toEqual({ title: "Report", tags: ["handoff"], revision: 2, updatedAt: "2026-10-03T01:00:00.000Z" });
  expect(Object.isFrozen(updated)).toBe(true); expect(Object.isFrozen(updated.content)).toBe(true); expect(Object.isFrozen(updated.metadata.tags)).toBe(true);
});
it("refuses stale edits without overwriting a newer title", async () => {
  const f = fixture(); await f.core.updateMetadata({ id: "artifact-1", expectedRevision: 1, title: "First" });
  await expect(f.core.updateMetadata({ id: "artifact-1", expectedRevision: 1, title: "Stale" })).rejects.toMatchObject({ code: "conflict" });
  expect(f.saved().metadata.title).toBe("First"); expect(f.writes()).toBe(1);
});
it("does not accept content fields in a metadata update", () => {
  expect(UpdateArtifactMetadataSchema.safeParse({ id: "artifact-1", expectedRevision: 1, title: "Changed", sha256: "b".repeat(64) }).success).toBe(false);
});
it("checks storage identity rather than granting access through original creator metadata", async () => {
  const f = fixture(); f.grant({ actorId: 99, identityId: "foreign", credentialId: "foreign" });
  await expect(f.core.updateMetadata({ id: "artifact-1", expectedRevision: 1, title: "Denied" })).rejects.toMatchObject({ code: "forbidden" }); expect(f.writes()).toBe(0);
});
it("revalidates the original credential before returning asynchronously loaded data", async () => {
  const f = fixture(); f.repository.get = async () => { f.grant({ actorId: 7, identityId: "owned", credentialId: "replacement" }); return f.saved(); };
  await expect(f.core.read("artifact-1")).rejects.toMatchObject({ code: "forbidden" }); expect(f.calls()).toBe(2);
});
it("refuses cancellation before a metadata write", async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await expect(f.core.updateMetadata({ id: "artifact-1", expectedRevision: 1, tags: [] }, abort.signal)).rejects.toThrow(); expect(f.writes()).toBe(0); expect(f.calls()).toBe(0);
});
it("keeps untouched metadata and supports clearing a title", async () => {
  const f = fixture(); await f.core.updateMetadata({ id: "artifact-1", expectedRevision: 1, title: "Title", tags: ["keep"] });
  const result = await f.core.updateMetadata({ id: "artifact-1", expectedRevision: 2, title: null });
  expect(result.metadata.title).toBeNull(); expect(result.metadata.tags).toEqual(["keep"]);
});
it("refuses malformed filenames, hashes and duplicate tags", () => {
  const value = initial();
  for (const filename of ["../report", "folder/report", "report\r\nHeader: value"]) expect(ArtifactRecordSchema.safeParse({ ...value, content: { ...value.content, filename } }).success).toBe(false);
  expect(ArtifactRecordSchema.safeParse({ ...value, content: { ...value.content, sha256: "unknown" } }).success).toBe(false);
  expect(UpdateArtifactMetadataSchema.safeParse({ id: value.id, expectedRevision: 1, tags: ["same", "same"] }).success).toBe(false);
});

it("revalidates list authority before returning metadata", async () => {
  const f = fixture();
  f.repository.list = async () => { f.grant({ actorId: 7, identityId: "owned", credentialId: "replacement" }); return [f.saved()]; };
  await expect(f.core.list({ limit: 10 })).rejects.toMatchObject({ code: "forbidden" });
});
it("returns a stable cursor for a full page and freezes its records", async () => {
  const f = fixture(), page = await f.core.list({ limit: 1 });
  expect(page.nextCursor).toEqual({ createdAt: f.saved().content.createdAt, id: "artifact-1" });
  expect(Object.isFrozen(page.items)).toBe(true); expect(Object.isFrozen(page.nextCursor)).toBe(true);
});

it("creates, lists, updates and revokes share grants through core", async () => {
  let share: ShareGrantRecord | undefined;
  const repository: ArtifactRepository = {
    identityId: "owned",
    async get() { return initial(); },
    async list() { return [initial()]; },
    transaction(operation) {
      return operation({
        get: () => initial(),
        replaceMetadata: () => true,
        getShare: () => share,
        createShare: (record) => { share = record; },
        updateShare: (_id, expected, update) => {
          if (!share || share.revision !== expected) return false;
          share = { ...share, ...update };
          return true;
        },
        revokeShare: (_id: string) => {
          if (!share) return false;
          share.revoked = true;
          return true;
        },
      });
    },
    getShare: async () => share,
    listShares: async () => share ? [share] : [],
  };
  const core = createArtifactCore({
    repository,
    access: { async authorize() { return { actorId: 7, identityId: "owned", credentialId: "tok" }; } },
    now: () => "2026-10-03T01:00:00.000Z",
    newId: () => "share-123",
    hashToken: async (t) => "a".repeat(64),
    hashPassword: async (p, salt) => "b".repeat(64),
  });
  const created = await core.createShare({ artifactId: "artifact-1", expiresInSeconds: 3600, password: "secret-pass" });
  expect(created.metadata.id).toBe("share-123");
  expect(created.metadata.hasPassword).toBe(true);
  expect(created.token).toBeDefined();

  const shares = await core.listShares("artifact-1");
  expect(shares.length).toBe(1);
  expect(shares[0].id).toBe("share-123");

  const updated = await core.updateShare({ shareId: "share-123", expectedRevision: 1, revoked: true });
  expect(updated.revoked).toBe(true);
  expect(updated.revision).toBe(2);

  await core.revokeShare("share-123");
  expect(share?.revoked).toBe(true);
});

it("streams artifact content when blobs store is supplied", async () => {
  const f = fixture();
  const chunks = [Buffer.from("hello "), Buffer.from("world")];
  const unused = () => { throw new Error("only streaming is exercised here"); };
  const blobs: ArtifactBlobStore = {
    stage: async () => unused(),
    publish: async () => unused(),
    discard: async () => unused(),
    stream: async () => (async function* () { for (const chunk of chunks) yield chunk; })(),
  };
  const core = createArtifactCore({
    repository: f.repository,
    access: { async authorize() { return { actorId: 7, identityId: "owned", credentialId: "tok" }; } },
    blobs,
    now: () => "2026-10-03T01:00:00.000Z",
  });
  const result = await core.streamContent("artifact-1");
  expect(result.record.id).toBe("artifact-1");
  const readChunks: Uint8Array[] = [];
  for await (const chunk of result.stream) readChunks.push(chunk);
  expect(Buffer.concat(readChunks).toString()).toBe("hello world");
});
