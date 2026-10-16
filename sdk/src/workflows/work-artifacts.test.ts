import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { WorkArtifactStore } from "./work-artifacts.js";
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function store(max = 1024) {
  const root = mkdtempSync(join(tmpdir(), "work-artifacts-"));
  roots.push(root);
  return new WorkArtifactStore(join(root, "retained"), max);
}
const metadata = {
  owner_identity: "alice",
  purpose: "input" as const,
  media_type: "application/json",
};
it("retains exact content, deduplicates staging and rejects corruption and size mismatch", () => {
  const artifacts = store(),
    source = Buffer.from('{"accepted":true}');
  const reference = artifacts.stage(source, metadata);
  expect(artifacts.stage(source, metadata)).toEqual(reference);
  expect(artifacts.verify(reference)).toEqual(source);
  expect(() => artifacts.verify({ ...reference, bytes: reference.bytes + 1 })).toThrow(/size/);
  writeFileSync(artifacts.path(reference), "x".repeat(reference.bytes));
  expect(() => artifacts.verify(reference)).toThrow(/digest/);
  expect(() => artifacts.stage(source, metadata)).toThrow(/digest/);
});
it("cannot use owner names or supplied digests as traversal paths", () => {
  const artifacts = store();
  const reference = artifacts.stage(Buffer.from("safe"), {
    ...metadata,
    owner_identity: "../../outside",
  });
  expect(artifacts.path(reference)).toMatch(
    new RegExp(`^${artifacts.root}/[a-f0-9]{64}/[a-f0-9]{64}$`),
  );
  expect(() => artifacts.path({ ...reference, digest: "../../outside" })).toThrow();
});
it("refuses a symbolic-link namespace and a symbolic-link retained blob", () => {
  const artifacts = store();
  const reference = artifacts.stage(Buffer.from("safe"), metadata);
  const path = artifacts.path(reference),
    directory = dirname(path),
    outside = join(artifacts.root, "outside");
  writeFileSync(outside, "safe");
  rmSync(path);
  symlinkSync(outside, path);
  expect(() => artifacts.verify(reference)).toThrow();
  rmSync(directory, { recursive: true });
  symlinkSync(dirname(outside), directory);
  expect(() => artifacts.path(reference)).toThrow(/symlink/);
  expect(readFileSync(outside, "utf8")).toBe("safe");
});
it("separates identities, enforces bounded reads/writes, and binds the store to one owner", () => {
  const artifacts = store(4),
    bytes = Buffer.from("same");
  const alice = artifacts.stage(bytes, metadata),
    bob = artifacts.stage(bytes, { ...metadata, owner_identity: "bob" });
  expect(alice.digest).toBe(bob.digest);
  expect(artifacts.path(alice)).not.toBe(artifacts.path(bob));
  expect(() => artifacts.stage(Buffer.from("large"), metadata)).toThrow(/byte limit/);
  expect(() => artifacts.verify({ ...alice, bytes: 5000 })).toThrow(/byte limit/);
  artifacts.claimOwner("owner-A");
  artifacts.claimOwner("owner-A");
  expect(() => artifacts.claimOwner("owner-B")).toThrow(/another owner/);
  expect(existsSync(artifacts.path(alice))).toBe(true);
});
it("bounds and advances staging scans and ignores non-artifact names", () => {
  const artifacts = store();
  const expected = Array.from({ length: 70 }, (_, index) =>
    artifacts.stage(Buffer.from(String(index)), metadata),
  );
  writeFileSync(join(artifacts.root, "not-a-namespace"), "ignore");
  const first = artifacts.scanStaging(32),
    second = artifacts.scanStaging(32),
    third = artifacts.scanStaging(32);
  expect(new Set([...first, ...second, ...third].map((row) => row.file))).toEqual(
    new Set(expected.map((row) => row.digest)),
  );
  expect(() => artifacts.scanStaging(100000)).toThrow(/budget/);
  artifacts.close();
  expect(createHash("sha256").update("0").digest("hex")).toBe(expected[0].digest);
});
