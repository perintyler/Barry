import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ExecutorJournal } from "./executor-journal.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";

const roots: string[] = [],
  journals: ExecutorJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tables = (db: SqliteDatabase) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => String(row.name));

// Reconstruct the on-disk shape an older build left behind: v4 predates the
// delivery/claim-inbox tables (6808aad00); v3 also predates stage outputs (8542c1dbf).
const removedSince: Record<number, string[]> = {
  4: ["execution_deliveries", "execution_claim_inbox"],
  3: ["execution_deliveries", "execution_claim_inbox", "execution_stage_outputs"],
};

// Target (T-UP4, D8 L155 / UP1): step through real per-version migrations to v5 (or refuse with a path); flip when fixed.
it.each([4, 3])(
  "gap G5: a v%i executor journal is upgraded only by re-running the v5 CREATE IF NOT EXISTS initialize block, with retained receipts backfilled as pending deliveries",
  (version) => {
    const root = mkdtempSync(join(tmpdir(), "executor-journal-upgrade-"));
    roots.push(root);
    const path = join(root, "executor.db"),
      options = { path, installation: "host" };
    new ExecutorJournal(options).close();

    const old = new SqliteDatabase(path);
    for (const table of removedSince[version]) old.exec(`DROP TABLE ${table}`);
    old
      .prepare("INSERT INTO execution_receipts VALUES(?,?,?,?,?,?,?)")
      .run("receipt-old", "owner", "workflow", "activity", 1, "d".repeat(64), '{"retained":"v' + version + '"}');
    old.exec(`PRAGMA user_version=${version}`);
    const before = tables(old);
    old.close();
    expect(before).not.toContain("execution_deliveries");

    const journal = new ExecutorJournal(options);
    journals.push(journal);
    // No version-specific step ran: the same idempotent DDL re-created what was missing and restamped.
    const db = new SqliteDatabase(path);
    try {
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(5);
      expect(tables(db)).toEqual([...before, ...removedSince[version]].sort());
      expect(db.prepare("SELECT receipt_ref,receipt FROM execution_receipts").all()).toEqual([
        { receipt_ref: "receipt-old", receipt: '{"retained":"v' + version + '"}' },
      ]);
      expect(db.prepare("SELECT receipt_ref,acknowledged,visits FROM execution_deliveries").all()).toEqual([
        { receipt_ref: "receipt-old", acknowledged: null, visits: 0 },
      ]);
    } finally {
      db.close();
    }
    expect(journal.pendingDeliveryCount("owner")).toBe(1);
  },
);
