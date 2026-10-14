import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { publicError, StorageHealth } from "./errors.js";

it("classifies real shared-driver busy errors and degrades readiness", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-workflow-busy-"));
  const path = join(root, "workflows.db"), writer = new SqliteDatabase(path), other = new SqliteDatabase(path);
  try {
    writer.exec("CREATE TABLE work(id TEXT); BEGIN IMMEDIATE");
    other.exec("PRAGMA busy_timeout=1");
    let failure: unknown;
    try { other.exec("BEGIN IMMEDIATE"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(publicError(failure)).toMatchObject({ status: 503, body: { code: "StoreBusy", retryable: true, retryAfterMs: 250 } });
    const health = new StorageHealth(); health.observe(failure);
    expect(health.state).toBe("degraded");
    writer.exec("ROLLBACK");
  } finally { other.close(); writer.close(); rmSync(root, { recursive: true, force: true }); }
});

it("requires recovery for a corrupt database reported by the shared driver", () => {
  const root = mkdtempSync(join(tmpdir(), "barry-workflow-corrupt-"));
  const path = join(root, "workflows.db"); writeFileSync(path, "not a SQLite database");
  const db = new SqliteDatabase(path);
  try {
    let failure: unknown;
    try { db.prepare("SELECT name FROM sqlite_master").all(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(publicError(failure)).toMatchObject({ status: 503, body: { code: "StoreUnavailable", retryable: true } });
    const health = new StorageHealth(); health.observe(failure);
    expect(health.state).toBe("recovery_required");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
