/** G8 (D7/CR3): the delegation key ring has the same custody as the worker credential. */
import { chmodSync, linkSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readWorkDelegationKeys } from "./work-delegation-config.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const ring = { issuer: [{ id: "key-1", secret: "s".repeat(32), not_before: 0, not_after: 2_000_000_000_000 }] };
function keyRing(mode: number) {
  const root = mkdtempSync(join(tmpdir(), "work-delegation-config-perms-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "delegation-keys.json");
  writeFileSync(path, JSON.stringify(ring), { mode: 0o600 });
  chmodSync(path, mode);
  expect(statSync(path).mode & 0o777).toBe(mode);
  return { root, path };
}

it("loads an owner-only 0600 key ring", () => {
  expect(readWorkDelegationKeys(keyRing(0o600).path)).toEqual(ring);
});

it("refuses a relative key ring path and an invalid ring without echoing key material", () => {
  const { path } = keyRing(0o600);
  expect(() => readWorkDelegationKeys("delegation-keys.json")).toThrow(expect.objectContaining({ code: "WorkDelegationConfigurationInvalid", status: 503 }));
  writeFileSync(path, JSON.stringify({ issuer: [{ ...ring.issuer[0], not_after: 0 }] }));
  expect(() => readWorkDelegationKeys(path)).toThrow("Dedicated work delegation key configuration is unreadable or invalid.");
  try { readWorkDelegationKeys(path); } catch (error) { expect(String((error as Error).message)).not.toContain(ring.issuer[0].secret); }
});

const refused = expect.objectContaining({ code: "WorkDelegationConfigurationInvalid", status: 503 });

it.each([0o644, 0o664, 0o604, 0o666, 0o640])("refuses a group or world accessible key ring at mode %o", mode => {
  expect(() => readWorkDelegationKeys(keyRing(mode).path)).toThrow(refused);
});

it("refuses a symlinked key ring even when its target is owner-only", () => {
  const { root, path } = keyRing(0o600), link = join(root, "linked-keys.json");
  symlinkSync(path, link);
  expect(() => readWorkDelegationKeys(link)).toThrow(refused);
});

it("refuses a hard-linked key ring with a second directory entry", () => {
  const { root, path } = keyRing(0o600), second = join(root, "second-entry.json");
  linkSync(path, second);
  expect(statSync(path).nlink).toBe(2);
  expect(() => readWorkDelegationKeys(path)).toThrow(refused);
});

it("refuses a dangling symlink and a directory with the generic configuration error", () => {
  const { root } = keyRing(0o600), dangling = join(root, "dangling.json");
  symlinkSync(join(root, "absent.json"), dangling);
  for (const path of [dangling, root]) expect(() => readWorkDelegationKeys(path)).toThrow(expect.objectContaining({ code: "WorkDelegationConfigurationInvalid" }));
});
