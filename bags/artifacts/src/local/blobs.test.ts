import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { mkdtemp, writeFile, readFile, readdir, stat, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalArtifactBlobs } from "./blobs.js";
import { MAX_ARTIFACT_BYTES } from "../blobs.js";

const opened = vi.hoisted(() => [] as { path: string; handle: import("node:fs/promises").FileHandle }[]);
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async open(...args: Parameters<typeof fs.open>) {
      const handle = await fs.open(...args);
      opened.push({ path: String(args[0]), handle });
      return handle;
    },
  };
});

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "barry-artifact-blobs-")); directories.push(directory);
  const databasePath = join(directory, "custom.db");
  const database = new Database(databasePath); database.exec("CREATE TABLE fixture (id INTEGER)"); database.close();
  const blobs = await createLocalArtifactBlobs(databasePath);
  const path = (hash: string) => join(blobs.directory, "sha256", hash.slice(0, 2), hash);
  return { blobs, databasePath, path };
}
async function* bytes(...chunks: Uint8Array[]) { for (const chunk of chunks) yield chunk; }
it("streams exact binary bytes into a custom database sidecar with private permissions", async () => {
  const { blobs, databasePath, path } = await fixture();
  const binary = Buffer.from([0, 255, 13, 10, 0, 128]);
  const blob = await blobs.stage("upload-1", bytes(binary.subarray(0, 2), binary.subarray(2)));
  expect(blob).toEqual({ sha256: createHash("sha256").update(binary).digest("hex"), size: binary.length });
  expect(blobs.directory).toBe(`${databasePath}.blobs`);
  await blobs.publish("upload-1", blob); await blobs.verify(blob); await blobs.discard("upload-1");
  expect(await readFile(path(blob.sha256))).toEqual(binary);
  expect((await stat(path(blob.sha256))).mode & 0o777).toBe(0o400);
  expect((await stat(blobs.directory)).mode & 0o777).toBe(0o700);
  expect(await readdir(join(blobs.directory, "staging"))).toEqual([]);
});
it("concurrent equal-content publishers retain one verified immutable blob", async () => {
  const { blobs, path } = await fixture(), content = Buffer.from("same content");
  const first = await blobs.stage("first", bytes(content)), second = await blobs.stage("second", bytes(content));
  await Promise.all([blobs.publish("first", first), blobs.publish("second", second)]);
  expect((await stat(path(first.sha256))).nlink).toBe(2);
  await Promise.all([blobs.discard("first"), blobs.discard("second")]);
  expect((await stat(path(first.sha256))).nlink).toBe(1); expect(await readFile(path(first.sha256))).toEqual(content);
});
it("refuses a corrupt existing blob without overwriting it", async () => {
  const { blobs, path } = await fixture(), content = Buffer.from("original");
  const blob = await blobs.stage("first", bytes(content)); await blobs.publish("first", blob); await blobs.discard("first");
  await chmod(path(blob.sha256), 0o600); await writeFile(path(blob.sha256), "tampered");
  await blobs.stage("retry", bytes(content));
  await expect(blobs.publish("retry", blob)).rejects.toMatchObject({ code: "unavailable" });
  expect(await readFile(path(blob.sha256), "utf8")).toBe("tampered");
  await expect(blobs.verify(blob)).rejects.toMatchObject({ code: "unavailable" });
});
it("rejects an over-limit upload and removes its partial staging file", async () => {
  const { blobs } = await fixture();
  await expect(blobs.stage("too-big", bytes(new Uint8Array(MAX_ARTIFACT_BYTES), new Uint8Array(1)))).rejects.toMatchObject({ code: "too_large" });
  expect(await readdir(join(blobs.directory, "staging"))).toEqual([]);
});
it("cleans staging when a producer fails midway through a stream", async () => {
  const { blobs } = await fixture();
  async function* failing() { yield Buffer.from("partial"); throw new Error("producer failed"); }
  await expect(blobs.stage("failed", failing())).rejects.toThrow("producer failed");
  expect(await readdir(join(blobs.directory, "staging"))).toEqual([]);
});
it("cancels a hung producer without waiting for its next or return", async () => {
  const { blobs } = await fixture(), controller = new AbortController();
  const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: () => new Promise(() => {}) }; } };
  const pending = blobs.stage("hung", source, controller.signal);
  setTimeout(() => controller.abort(new Error("cancelled")), 20);
  await expect(pending).rejects.toThrow("cancelled");
  expect(await readdir(join(blobs.directory, "staging"))).toEqual([]);
}, 2000);
it("rejects traversal and symlinked staging or published files", async () => {
  const { blobs, path } = await fixture();
  await expect(blobs.stage("../outside", bytes(Buffer.from("unsafe")))).rejects.toThrow();
  const blob = await blobs.stage("first", bytes(Buffer.from("data")));
  await blobs.publish("first", blob); await blobs.discard("first");
  await rm(path(blob.sha256)); await symlink("/etc/hosts", path(blob.sha256));
  await expect(blobs.verify(blob)).rejects.toThrow();
  const outside = join(blobs.directory, "outside"); await writeFile(outside, "keep");
  await symlink(outside, join(blobs.directory, "staging", "link"));
  await expect(blobs.stage("link", bytes(Buffer.from("overwrite")))).rejects.toThrow();
  expect(await readFile(outside, "utf8")).toBe("keep");
});
it("staging snapshots producer-owned buffers before asynchronous writes", async () => {
  const { blobs, path } = await fixture(), original = Buffer.from("original"), buffer = Buffer.from(original);
  async function* changing() { yield buffer; buffer.fill(0); }
  const blob = await blobs.stage("snapshot", changing()); await blobs.publish("snapshot", blob);
  expect(await readFile(path(blob.sha256))).toEqual(original);
});
it("accepts empty files and safely discards an already removed staging file", async () => {
  const { blobs } = await fixture(), blob = await blobs.stage("empty", bytes());
  expect(blob.size).toBe(0); await blobs.publish("empty", blob); await blobs.verify(blob);
  await blobs.discard("empty"); await blobs.discard("empty"); await blobs.verify(blob);
});
it("reports a missing referenced blob without inventing bytes", async () => {
  const { blobs } = await fixture();
  await expect(blobs.verify({ sha256: "a".repeat(64), size: 1 })).rejects.toThrow();
});
it("a cancelled endless stream of empty chunks yields to the abort timer", async () => {
  const { blobs } = await fixture(), controller = new AbortController();
  async function* emptyForever() { for (;;) yield new Uint8Array(); }
  const pending = blobs.stage("empty-forever", emptyForever(), controller.signal);
  setTimeout(() => controller.abort(new Error("cancelled")), 20);
  await expect(pending).rejects.toThrow("cancelled");
  expect(await readdir(join(blobs.directory, "staging"))).toEqual([]);
}, 2000);

it("refuses a symlinked hash bucket before inspecting an external file", async () => {
  const { blobs, path } = await fixture(), blob = await blobs.stage("safe", bytes(Buffer.from("safe")));
  await blobs.publish("safe", blob); await blobs.discard("safe");
  const bucket = join(blobs.directory, "sha256", blob.sha256.slice(0, 2));
  await rm(bucket, { recursive: true });
  await symlink(blobs.directory, bucket);
  await expect(blobs.verify(blob)).rejects.toMatchObject({ code: "unavailable" });
  expect(path(blob.sha256)).toContain(blob.sha256);
});

it("streams published blob bytes and verifies checksum on read completion", async () => {
  const { blobs } = await fixture(), content = Buffer.from("streaming content test bytes");
  const blob = await blobs.stage("stream-test", bytes(content));
  await blobs.publish("stream-test", blob);
  await blobs.discard("stream-test");
  const stream = await blobs.stream(blob);
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(content);
});

it.each([false, true])("closes a returned blob stream before cancellation resolves (started=%s)", async started => {
  const { blobs, path } = await fixture();
  const blob = await blobs.stage("cancel", bytes(Buffer.alloc(1024 * 1024, 1)));
  await blobs.publish("cancel", blob); await blobs.discard("cancel");
  const stream = await blobs.stream(blob);
  const handle = opened.filter(entry => entry.path === path(blob.sha256)).at(-1)!.handle;
  const iterator = stream[Symbol.asyncIterator]();
  if (started) expect((await iterator.next()).done).toBe(false);
  await iterator.return?.();
  expect(handle.fd).toBe(-1);
});
