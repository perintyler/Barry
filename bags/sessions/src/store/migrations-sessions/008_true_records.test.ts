/**
 * Migration 008 against a store built by the real migrations before it, with
 * foreign keys on, as the live store runs: each rewrite touches exactly the
 * rows it names.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrateStore } from "@barry-rocks/sdk/stores";
import MIGRATIONS from "../../generated/sessions-migrations.js";
const BEFORE = MIGRATIONS.slice(0, 7);
const trueRecords = MIGRATIONS[7].sql;

function storeAtSeven(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateStore(db, BEFORE, "sessions.db");
  const session = db.prepare("INSERT INTO sessions (id, metadata) VALUES (?, ?)");
  session.run("tui-old", JSON.stringify({ mode: "guest-plus", provider: "claude" }));
  session.run("tui-new", JSON.stringify({ mode: "guest", provider: "claude" }));
  session.run("api-unmeasured", JSON.stringify({ mode: "hosted", provider: "claude" }));
  session.run("api-measured", JSON.stringify({ mode: "hosted", provider: "codex", vendor_version: "0.115.0" }));
  db.prepare("INSERT INTO provider_sessions (session_id, provider, provider_session_id) VALUES (?, ?, ?)").run("tui-old", "claude", "conv-1");
  const provider = db.prepare("INSERT INTO providers (id, key, label) VALUES (?, ?, ?)");
  const model = db.prepare("INSERT INTO models (provider_id, model_id, label) VALUES (?, ?, ?)");
  for (const [id, key] of [[91, "test-prov"], [92, "test-prov-2"], [93, "brand-new-provider"], [94, "zai"]] as const) {
    provider.run(id, key, key);
    model.run(id, `${key}-model`, "a model");
  }
  return db;
}

const metadataOf = (db: Database.Database, id: string) =>
  JSON.parse((db.prepare("SELECT metadata FROM sessions WHERE id = ?").get(id) as { metadata: string }).metadata) as Record<string, unknown>;

describe("008_true_records", () => {
  it("records guest for guest-plus rows, and marks unmeasured hosted rows unverified", () => {
    const db = storeAtSeven();
    migrateStore(db, [...BEFORE, { name: "008_true_records.sql", sql: trueRecords }], "sessions.db");

    expect(metadataOf(db, "tui-old")).toEqual({ mode: "guest", provider: "claude" });
    expect(metadataOf(db, "tui-new")).toEqual({ mode: "guest", provider: "claude" });
    expect(metadataOf(db, "api-unmeasured")).toEqual({ mode: "hosted", provider: "claude", guarantees_unverified: true });
    expect(metadataOf(db, "api-measured")).toEqual({ mode: "hosted", provider: "codex", vendor_version: "0.115.0" });
  });

  it("admits claude-code beside claude, and removes only the test providers and their models", () => {
    const db = storeAtSeven();
    migrateStore(db, [...BEFORE, { name: "008_true_records.sql", sql: trueRecords }], "sessions.db");

    const adapters = (db.prepare("SELECT id FROM agent_adapters ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id);
    expect(adapters).toEqual(["claude", "claude-code", "codex", "cursor", "opencode"]);
    // Old code still writing "claude", and new rows naming the new id, are both valid.
    const insert = db.prepare("INSERT INTO provider_sessions (session_id, provider) VALUES ('tui-new', ?)");
    expect(() => insert.run("claude")).not.toThrow();
    expect(() => insert.run("claude-code")).not.toThrow();

    expect(db.prepare("SELECT key FROM providers ORDER BY key").all()).toEqual([{ key: "zai" }]);
    expect(db.prepare("SELECT model_id FROM models").all()).toEqual([{ model_id: "zai-model" }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
