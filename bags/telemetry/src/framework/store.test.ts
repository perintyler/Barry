import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBagStore } from "./store.js";

describe("openBagStore", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "bagstore-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const DDL = "CREATE TABLE IF NOT EXISTS t (a INTEGER);";

  it("creates the file and its parent directory", () => {
    const path = join(tmp(), "nested", "deep", "x.db");
    const db = openBagStore({ path, ddl: DDL });
    expect(existsSync(path)).toBe(true);
    db.close();
  });

  /**
   * The pragmas are the whole reason this helper exists rather than four copies,
   * so assert them rather than trusting that the calls are present.
   */
  it("applies WAL and NORMAL to every store", () => {
    const db = openBagStore({ path: join(tmp(), "x.db"), ddl: DDL });
    expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    // synchronous NORMAL is 1.
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    db.close();
  });

  // Preserve each store’s deliberate lock timeout; metrics collection must not stall on contention.
  // Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-064
  it("pins better-sqlite3's busy_timeout default, which the explicit calls duplicate", () => {
    const implicit = openBagStore({ path: join(tmp(), "single.db"), ddl: DDL });
    expect(implicit.pragma("busy_timeout", { simple: true })).toBe(5000);
    implicit.close();

    const explicit = openBagStore({ path: join(tmp(), "shared.db"), ddl: DDL, busyTimeoutMs: 5000 });
    expect(explicit.pragma("busy_timeout", { simple: true })).toBe(5000);
    explicit.close();

    // A store that asks for something different gets it.
    const custom = openBagStore({ path: join(tmp(), "custom.db"), ddl: DDL, busyTimeoutMs: 250 });
    expect(custom.pragma("busy_timeout", { simple: true })).toBe(250);
    custom.close();
  });

  /**
   * Every caller runs this on every open — it is what lets the bag have no
   * migration framework — so a second open must not fail on existing tables.
   */
  it("is idempotent across repeated opens", () => {
    const path = join(tmp(), "x.db");
    const a = openBagStore({ path, ddl: DDL });
    a.prepare("INSERT INTO t (a) VALUES (1)").run();
    a.close();

    const b = openBagStore({ path, ddl: DDL });
    expect(b.prepare("SELECT count(*) c FROM t").get()).toEqual({ c: 1 });
    b.close();
  });
});
