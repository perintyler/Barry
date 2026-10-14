import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { closeDb, getDb } from "./db.js";
import { record } from "./index.js";
import { pruneChanges } from "./retention.js";

let root: string;
afterEach(() => { closeDb(); delete process.env.BARRY_FILE_TRACKER_DB; if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  root = mkdtempSync(join(tmpdir(), "tracker-retention-"));
  const path = join(root, "tracker.db");
  process.env.BARRY_FILE_TRACKER_DB = path;
  return { db: getDb(), path };
}
const now = Date.parse("2026-10-09T12:00:00Z");
const endedAt = "2026-01-01T00:00:00Z";

it("prunes 1,000 old full-content records, shrinks storage and preserves recent append-only records", async () => {
  const { db, path } = fixture();
  const insert = db.prepare("INSERT INTO changes(session_id,file_path,diff,created_at) VALUES(?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < 1000; i++) insert.run("old", `${i}.txt`, JSON.stringify({ type: "full", content: "x".repeat(1024) }), endedAt);
  })();
  record({ sessionId: "old", filePath: "recent.txt", diff: { type: "full", content: "keep" } });
  db.pragma("wal_checkpoint(TRUNCATE)");
  const before = statSync(path).size;
  expect(await pruneChanges(async id => ({ id, status: "completed", pinned: false, endedAt }), now)).toMatchObject({ removed: 1000 });
  db.pragma("wal_checkpoint(TRUNCATE)");
  expect(statSync(path).size).toBeLessThan(before);
  expect(db.prepare("SELECT file_path FROM changes").all()).toEqual([{ file_path: "recent.txt" }]);
  expect(() => db.exec("DELETE FROM changes")).toThrow("append-only");
  expect(() => db.exec("UPDATE changes SET file_path='changed'")).toThrow("append-only");
});

it("keeps live, pinned, recent, unknown, mismatched and unreadable sessions", async () => {
  const { db } = fixture();
  const states = ["live", "pinned", "recent", "unknown", "mismatch", "unreadable", "bad-date"];
  for (const id of states) db.prepare("INSERT INTO changes(session_id,file_path,created_at) VALUES(?,?,?)").run(id, `${id}.txt`, endedAt);
  expect(await pruneChanges(async id => {
    if (id === "unknown") return null;
    if (id === "unreadable") throw new Error("unavailable");
    return { id: id === "mismatch" ? "other" : id, status: id === "live" ? "running" : "completed", pinned: id === "pinned", endedAt: id === "recent" ? "2026-10-08T00:00:00Z" : id === "bad-date" ? "invalid" : endedAt };
  }, now)).toEqual({ removed: 0, checked: 7, kept: 7 });
  expect(db.prepare("SELECT count(*) AS n FROM changes").get()).toEqual({ n: 7 });
});

it("advances past a full batch of unknown sessions so later closed sessions are reachable", async () => {
  const { db } = fixture();
  for (let i = 0; i < 101; i++) db.prepare("INSERT INTO changes(session_id,file_path,created_at) VALUES(?,?,?)").run(String(i).padStart(3, "0"), "file", endedAt);
  const get = async (id: string) => id === "100" ? { id, status: "cancelled", pinned: false, endedAt } : null;
  expect((await pruneChanges(get, now)).removed).toBe(0);
  expect((await pruneChanges(get, now)).removed).toBe(1);
});

it("rolls back deletion and restores guards when another delete trigger aborts pruning", async () => {
  const { db } = fixture();
  db.prepare("INSERT INTO changes(session_id,file_path,created_at) VALUES('old','file',?)").run(endedAt);
  db.exec("CREATE TRIGGER reject_prune BEFORE DELETE ON changes BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  await expect(pruneChanges(async id => ({ id, status: "failed", pinned: false, endedAt }), now)).rejects.toThrow("fixture failure");
  db.exec("DROP TRIGGER reject_prune");
  expect(db.prepare("SELECT count(*) AS n FROM changes").get()).toEqual({ n: 1 });
  expect(() => db.exec("DELETE FROM changes")).toThrow("append-only");
});
