import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeDb, getDb } from "./db.js";
import { record } from "./index.js";

let root: string;
afterEach(() => { closeDb(); delete process.env.BARRY_FILE_TRACKER_DB; if (root) rmSync(root, { recursive: true, force: true }); });
it("bounds a full-content change without dropping its provenance", () => {
  root = mkdtempSync(join(tmpdir(), "tracker-payload-"));
  process.env.BARRY_FILE_TRACKER_DB = join(root, "tracker.db");
  record({ sessionId: "session", filePath: "large.txt", tool: "Write", diff: { type: "full", content: "x".repeat(256 * 1024) }, sizeBytes: 256 * 1024 });
  const row = getDb().prepare("SELECT session_id, file_path, size_bytes, diff FROM changes").get() as { session_id: string; file_path: string; size_bytes: number; diff: string };
  expect(Buffer.byteLength(row.diff)).toBeLessThanOrEqual(64 * 1024);
  expect(row).toMatchObject({ session_id: "session", file_path: "large.txt", size_bytes: 256 * 1024 });
  expect(JSON.parse(row.diff)).toMatchObject({ type: "truncated", originalBytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
});

it("keeps small diffs exact and bounds escaped Unicode previews", () => {
  root = mkdtempSync(join(tmpdir(), "tracker-escaped-"));
  process.env.BARRY_FILE_TRACKER_DB = join(root, "tracker.db");
  const diff = { type: "edit", old_string: "before", new_string: "after" };
  record({ sessionId: "session", filePath: "small", diff });
  record({ sessionId: "session", filePath: "unicode", diff: { type: "full", content: "💡\n\"".repeat(65536) } });
  const rows = getDb().prepare("SELECT diff FROM changes ORDER BY id").all() as { diff: string }[];
  expect(JSON.parse(rows[0].diff)).toEqual(diff);
  expect(Buffer.byteLength(rows[1].diff)).toBeLessThanOrEqual(64 * 1024);
  expect(JSON.parse(rows[1].diff).type).toBe("truncated");
});
