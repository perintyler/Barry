import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteArtifactRepository } from "./catalog.js";
import { createArtifactCore, type ArtifactTransaction } from "../core.js";

const databases: Database.Database[] = [], directories: string[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(filepath = ":memory:") {
  const database = new Database(filepath); databases.push(database);
  const repository = createSqliteArtifactRepository(database, "owned");
  const core = createArtifactCore({
    repository,
    access: { async authorize() { return { actorId: 7, identityId: "owned", credentialId: "token" }; } },
    now: () => "2026-10-03T01:00:00.000Z",
    newId: () => "share-id-1",
    hashToken: async (t) => "a".repeat(64),
  });
  const seed = (id: string, filename = "report.txt", title: string | null = null, tags: string[] = []) => database.transaction(() => {
    database.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, "owned", filename, "text/plain", 7, "a".repeat(64), "text", "2026-10-03T00:00:00.000Z", 99, "owned", "session", null);
    database.prepare("INSERT INTO artifact_metadata VALUES (?, ?, ?, 1, ?)").run(id, title, JSON.stringify(tags), "2026-10-03T00:00:00.000Z");
  })();
  return { database, repository, core, seed };
}
it("persists metadata edits while preserving immutable content across reopening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barry-artifact-catalog-")); directories.push(directory);
  const filepath = join(directory, "artifacts.db"), first = fixture(filepath); first.seed("artifact-1");
  const original = await first.core.read("artifact-1");
  await first.core.updateMetadata({ id: original.id, expectedRevision: 1, title: "Saved", tags: ["final"] });
  first.database.close(); databases.splice(databases.indexOf(first.database), 1);
  const reopened = fixture(filepath), saved = await reopened.core.read("artifact-1");
  expect(saved.content).toEqual(original.content); expect(saved.metadata.title).toBe("Saved"); expect(saved.metadata.revision).toBe(2);
});
it("enforces content immutability and ownership against direct SQL", () => {
  const { database, seed } = fixture(); seed("artifact-1");
  expect(() => database.prepare("UPDATE artifacts SET filename = 'changed' WHERE id = 'artifact-1'").run()).toThrow(/immutable/);
  expect(() => database.prepare("DELETE FROM artifacts WHERE id = 'artifact-1'").run()).toThrow(/not supported/);
  expect(() => database.prepare("INSERT INTO artifacts SELECT 'foreign', 'other', filename, mime_type, size, sha256, kind, created_at, creator_actor_id, creator_identity_id, session_id, derived_from FROM artifacts").run()).toThrow(/identity/);
  expect(() => createSqliteArtifactRepository(database, "other")).toThrow(/forbidden/);
  expect(database.prepare("SELECT identity_id FROM artifact_catalog").get()).toEqual({ identity_id: "owned" });
});
it("does not acknowledge metadata writes inside a caller-owned transaction", async () => {
  const { database, seed, core } = fixture(); seed("artifact-1"); database.exec("BEGIN IMMEDIATE");
  try { await expect(core.updateMetadata({ id: "artifact-1", expectedRevision: 1, title: "Not durable" })).rejects.toMatchObject({ code: "unavailable" }); }
  finally { database.exec("ROLLBACK"); }
  expect((await core.read("artifact-1")).metadata.revision).toBe(1);
});
it("rolls back all metadata writes when a transaction callback fails", async () => {
  const { repository, seed, core } = fixture(); seed("artifact-1");
  expect(() => repository.transaction(transaction => {
    const existing = transaction.get("artifact-1")!;
    transaction.replaceMetadata(existing.id, 1, { ...existing.metadata, title: "Rollback", revision: 2 });
    throw new Error("abort");
  })).toThrow("abort");
  expect((await core.read("artifact-1")).metadata).toMatchObject({ title: null, revision: 1 });
});
it("rejects asynchronous transaction callbacks and rolls back their early changes", async () => {
  const { repository, seed, core } = fixture(); seed("artifact-1");
  expect(() => repository.transaction(async transaction => {
    const existing = transaction.get("artifact-1")!;
    transaction.replaceMetadata(existing.id, 1, { ...existing.metadata, title: "Queued", revision: 2 });
  })).toThrow(/unavailable/);
  expect((await core.read("artifact-1")).metadata.revision).toBe(1);
});
it("does not allow a retained transaction to mutate after commit", () => {
  const { repository, seed } = fixture(); seed("artifact-1"); let retained: ArtifactTransaction | undefined;
  repository.transaction(transaction => { retained = transaction; });
  expect(() => retained!.replaceMetadata("artifact-1", 1, { title: "Late", tags: [], revision: 2, updatedAt: "2026-10-03T01:00:00.000Z" })).toThrow(/unavailable/);
});
it("paginates equal timestamps without duplicates and searches literal tags/title/filename", async () => {
  const { repository, seed } = fixture(); seed("artifact-a", "100%_done.txt"); seed("artifact-b", "other.txt", "Summary"); seed("artifact-c", "last.txt", null, ["published"]);
  const first = await repository.list({ limit: 2 }); expect(first.map(artifact => artifact.id)).toEqual(["artifact-c", "artifact-b"]);
  const last = first.at(-1)!;
  expect((await repository.list({ limit: 2, cursor: { createdAt: last.content.createdAt, id: last.id } })).map(artifact => artifact.id)).toEqual(["artifact-a"]);
  for (const [query, id] of [["%_", "artifact-a"], ["Summary", "artifact-b"], ["published", "artifact-c"]]) expect((await repository.list({ limit: 10, query })).map(artifact => artifact.id)).toEqual([id]);
  expect(await repository.list({ limit: 10, kind: "image" })).toEqual([]);
});
it("two catalog connections cannot overwrite an already committed metadata revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "barry-artifact-catalog-")); directories.push(directory); const filepath = join(directory, "artifacts.db");
  const first = fixture(filepath); first.seed("artifact-1"); const second = fixture(filepath);
  await first.core.updateMetadata({ id: "artifact-1", expectedRevision: 1, title: "First" });
  await expect(second.core.updateMetadata({ id: "artifact-1", expectedRevision: 1, title: "Stale" })).rejects.toMatchObject({ code: "conflict" });
  expect((await second.core.read("artifact-1")).metadata.title).toBe("First");
});
it("SQL replacement cannot overwrite an existing immutable artifact", () => {
  const { database, seed } = fixture(); seed("artifact-1");
  expect(() => database.exec("INSERT OR REPLACE INTO artifacts SELECT id, identity_id, 'replacement', mime_type, size, sha256, kind, created_at, creator_actor_id, creator_identity_id, session_id, derived_from FROM artifacts")).toThrow(/immutable/);
});

it("replacement inserts cannot reset catalog ownership or metadata revisions", async () => {
  const { database, seed, core } = fixture(); seed("artifact-1");
  expect(() => database.prepare("INSERT OR REPLACE INTO artifact_catalog VALUES (1, 'foreign', 1)").run()).toThrow(/immutable/);
  expect(() => database.prepare("INSERT OR REPLACE INTO artifact_metadata VALUES ('artifact-1', 'Replaced', '[]', 1, '2026-10-03T00:00:00.000Z')").run()).toThrow(/revision/);
  expect((await core.read("artifact-1")).metadata).toMatchObject({ title: null, revision: 1 });
});
it("refuses reads of caller-owned uncommitted changes", async () => {
  const { database, seed, repository } = fixture(); seed("artifact-1"); database.exec("BEGIN IMMEDIATE");
  try {
    await expect(repository.get("artifact-1")).rejects.toMatchObject({ code: "unavailable" });
    await expect(repository.list({ limit: 10 })).rejects.toMatchObject({ code: "unavailable" });
  } finally { database.exec("ROLLBACK"); }
});

it("a rejected asynchronous callback cannot write after its transaction has ended", async () => {
  const { repository, seed, core } = fixture(); seed("artifact-1"); let late: Promise<boolean> | undefined;
  expect(() => repository.transaction(transaction => {
    late = Promise.resolve().then(() => transaction.replaceMetadata("artifact-1", 1, { title: "Late", tags: [], revision: 2, updatedAt: "2026-10-03T01:00:00.000Z" }));
    return late;
  })).toThrow(/unavailable/);
  await expect(late).rejects.toMatchObject({ code: "unavailable" });
  expect((await core.read("artifact-1")).metadata.revision).toBe(1);
});

it("creates, lists, updates, and revokes share grants in SQLite catalog", async () => {
  const { repository, seed, core } = fixture();
  seed("artifact-1");
  const created = await core.createShare({ artifactId: "artifact-1", expiresInSeconds: 3600 });
  expect(created.token).toMatch(/^[a-f0-9]{64}$/);
  expect(created.metadata).toMatchObject({ artifactId: "artifact-1", revision: 1, revoked: false });

  const shares = await core.listShares("artifact-1");
  expect(shares).toHaveLength(1);
  expect(shares[0].id).toBe(created.metadata.id);

  const updated = await core.updateShare({ shareId: created.metadata.id, expectedRevision: 1, expiresInSeconds: 7200 });
  expect(updated.revision).toBe(2);

  await core.revokeShare(created.metadata.id);
  const afterRevoke = await core.listShares("artifact-1");
  expect(afterRevoke[0].revoked).toBe(true);
});
