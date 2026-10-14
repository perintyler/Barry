import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `messages.model_id` on the SQLite write path.
 *
 * The persist path used to hardcode NULL here, because `resolveModelId`
 * joined `models`/`providers` in the other store and a cross-store join would
 * have made every message insert depend on that store being reachable.
 * Migration 003
 * moved the catalog into this store, so the join is local -- the condition the
 * old comment named ("reinstate a real value only when `models` itself moves").
 *
 * WHY THESE ASSERT ON THE RESOLVED ID, NOT MERELY "not null": resolveModelId is
 * best-effort and swallows every throw into `return null`. A broken port does
 * not raise -- model attribution just silently stops. A test that accepted any
 * non-throwing outcome would pass against exactly the regression it exists to
 * catch, so each case below pins the SPECIFIC id and the model it joins back to.
 */
process.env.BARRY_SESSIONS_DB = join(mkdtempSync(join(tmpdir(), "barry-modelid-")), "sessions.db");

const { getSessionsSqlite, closeSessionsDb } = await import("./sessions-db.js");
const { appendMessageSqlite } = await import("./sessions-sqlite-writes.js");
const { clearModelIdCache } = await import("./models-registry.js");

const SESSION = "s-model-id";
const ORIGIN = { provider: "claude", model: "claude-opus-5" };

function sqlite() {
  return getSessionsSqlite();
}

/** The catalog row every case below expects to be attributed to. */
let expectedModelId: number;

beforeEach(() => {
  clearModelIdCache();
  const db = sqlite();
  db.exec("DELETE FROM messages; DELETE FROM sessions; DELETE FROM models; DELETE FROM providers;");
  // Sparse ids on purpose: 1..n would also be produced by a renumbering bug.
  db.prepare("INSERT INTO providers (id, key, label, metadata) VALUES (7,'claude','Claude','{}')").run();
  db.prepare("INSERT INTO models (id, provider_id, model_id, label, metadata) VALUES (314,7,'claude-opus-5','Opus 5','{}')").run();
  expectedModelId = 314;
  db.prepare("INSERT INTO sessions (id, active, state, status, metadata) VALUES (?,1,'open','running','{}')").run(SESSION);
});

afterAll(() => {
  closeSessionsDb();
});

function modelIdOf(messageId: string): number | null {
  return (sqlite().prepare("SELECT model_id FROM messages WHERE id = ?").get(messageId) as { model_id: number | null }).model_id;
}

function rows(): Array<{ id: string; type: string; model_id: number | null; channel: string | null }> {
  return sqlite()
    .prepare("SELECT id, type, model_id, channel FROM messages ORDER BY sequence")
    .all() as never;
}

describe("appendMessageSqlite", () => {
  it("stamps the resolved model id on an assistant turn", async () => {
    await appendMessageSqlite(SESSION, { type: "text", role: "assistant", content: "hi" } as never, null, ORIGIN);
    const [row] = rows();
    expect(row.model_id).toBe(expectedModelId);
  });

  it("leaves model_id NULL on a user turn", async () => {
    // A user turn is not model-authored; borrowing the session's model would
    // assert a model that never produced the row.
    await appendMessageSqlite(SESSION, { type: "text", role: "user", content: "hi" } as never, null, ORIGIN);
    expect(rows()[0].model_id).toBeNull();
  });

  it("leaves model_id NULL when no origin is supplied", async () => {
    await appendMessageSqlite(SESSION, { type: "text", role: "assistant", content: "hi" } as never);
    expect(rows()[0].model_id).toBeNull();
  });

  it("discovers an unknown model rather than dropping attribution", async () => {
    // The catalog learns from real traffic: a model newer than the catalog
    // must still resolve, and must NOT collide with the curated row.
    await appendMessageSqlite(
      SESSION, { type: "text", role: "assistant", content: "hi" } as never, null,
      { provider: "claude", model: "claude-opus-6-unreleased" },
    );
    const id = rows()[0].model_id;
    expect(id).toBeTypeOf("number");
    expect(id).not.toBe(expectedModelId);
    const row = sqlite().prepare("SELECT model_id, metadata FROM models WHERE id = ?").get(id) as { model_id: string; metadata: string };
    expect(row.model_id).toBe("claude-opus-6-unreleased");
    expect(JSON.parse(row.metadata).discovered).toBe(true);
  });

  it("joins back to the right model, not merely to a non-null id", async () => {
    await appendMessageSqlite(SESSION, { type: "tool_start", name: "Read", input: {}, toolUseId: "t1" }, null, ORIGIN);
    const joined = sqlite().prepare(`
      SELECT md.model_id AS model, p.key AS provider
        FROM messages m JOIN models md ON md.id = m.model_id
                        JOIN providers p ON p.id = md.provider_id`).get() as { model: string; provider: string };
    expect(joined).toEqual({ model: "claude-opus-5", provider: "claude" });
  });
});

/**
 * The capture CHANNEL, which travels the same road as the model id.
 *
 * The column has existed since migration 006 and nothing ever wrote it —
 * every message row in the production store carried NULL and none carried one.
 * A column the schema declares, the store accepts and no caller fills reads as
 * "capture provenance exists" while recording nothing, and D4's acceptance
 * ("a week of sessions with hooks on and off shows equal message/tool counts")
 * cannot be measured without it: nothing says which rows arrived by hook.
 */
describe("appendMessageSqlite — the capture channel", () => {
  it("stamps the channel the caller reports", async () => {
    await appendMessageSqlite(
      SESSION,
      { type: "text", role: "assistant", content: "hi" } as never,
      null,
      { ...ORIGIN, channel: "hook" },
    );
    expect(rows()[0].channel).toBe("hook");
  });

  it("stamps it on a USER turn too, unlike model_id", async () => {
    // A user turn is not model-authored, so it carries no model. It was still
    // CAPTURED by something, and which route matters exactly as much.
    await appendMessageSqlite(
      SESSION,
      { type: "text", role: "user", content: "hi" } as never,
      null,
      { ...ORIGIN, channel: "hook" },
    );
    const [row] = rows();
    expect(row.model_id).toBeNull();
    expect(row.channel).toBe("hook");
  });

  it("leaves it NULL when the caller does not know", async () => {
    // NULL reads as "unknown", which is true. A default would make "captured
    // before provenance existed" indistinguishable from "captured over the
    // engine" — the confusion the column exists to remove.
    await appendMessageSqlite(SESSION, { type: "text", role: "assistant", content: "hi" } as never, null, ORIGIN);
    expect(rows()[0].channel).toBeNull();
  });

  it("[control] the assertions read the real column", async () => {
    // Without this, every check above would pass against a SELECT that never
    // returned `channel` at all.
    await appendMessageSqlite(
      SESSION,
      { type: "text", role: "assistant", content: "hi" } as never,
      null,
      { ...ORIGIN, channel: "telemetry" },
    );
    expect(rows()[0].channel).toBe("telemetry");
  });
});
