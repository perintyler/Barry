import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { barryReleasesDir } from "@barry-rocks/sdk/services";
import { readReceipts, receiptId, receiptSchema, writeReceipt, type Receipt } from "./receipts.js";
import { scratchEnvironment } from "./__tests__/release-home.js";
beforeEach(scratchEnvironment);
function receipt(): Receipt {
  return { format: 1, id: receiptId(), kind: "upgrade", state: "started", from: { kind: "release", version: "1.0.0", commit: "a".repeat(40) }, to: { kind: "link", target: "/checkout", node: "/node", commit: null }, generations: { before: null, after: null }, snapshot: null, services: [], started: new Date().toISOString() };
}
it("round trips strict receipts atomically with private permissions and time ordering", () => {
  const first = receipt(), second = { ...receipt(), id: "20990101T000000000Z-12345678" };
  writeReceipt(second); writeReceipt(first);
  expect(readReceipts()).toEqual([second, first]);
  const directory = join(barryReleasesDir(), "upgrades");
  expect(readdirSync(directory).sort()).toEqual([`${first.id}.json`, `${second.id}.json`]);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(join(directory, `${first.id}.json`)).mode & 0o777).toBe(0o600);
});
it("refuses unknown keys and paths in identifiers", () => {
  expect(() => receiptSchema.parse({ ...receipt(), extra: true })).toThrow();
  expect(() => receiptSchema.parse({ ...receipt(), generations: { before: "../escape", after: null } })).toThrow();
  expect(() => receiptSchema.parse({ ...receipt(), from: { ...receipt().from, extra: true } })).toThrow();
});
