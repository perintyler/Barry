import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { traceSession } from "./correlate.js";

const SESSION = "s-1";

function usageDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session_usage (session_id TEXT, model TEXT, total_tokens INT,
      cost_usd REAL, duration_ms INT, created_at INT);
    CREATE TABLE tool_invocation (session_id TEXT, name TEXT, duration_ms INT, created_at INT);
  `);
  return db;
}
function errorsDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE error_event (ts INT, level INT, service TEXT, msg TEXT, detail TEXT, ctx TEXT);`);
  return db;
}
function requestsDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE request (ts INT, service TEXT, method TEXT, path TEXT, status INT, duration_ms INT);`);
  return db;
}

describe("traceSession", () => {
  let usage: Database.Database, errors: Database.Database, requests: Database.Database;
  beforeEach(() => { usage = usageDb(); errors = errorsDb(); requests = requestsDb(); });
  afterEach(() => { usage.close(); errors.close(); requests.close(); });

  it("joins cost, tools and errors on the session id", () => {
    usage.prepare("INSERT INTO session_usage VALUES (?,?,?,?,?,?)").run(SESSION, "opus", 100, 1.5, 60_000, 1000);
    usage.prepare("INSERT INTO tool_invocation VALUES (?,?,?,?)").run(SESSION, "Bash", 12, 1010);
    errors.prepare("INSERT INTO error_event VALUES (?,?,?,?,?,?)")
      .run(1005, 50, "api", "boom", "", JSON.stringify({ sessionId: SESSION }));

    const t = traceSession(SESSION, { usage, errors, requests });
    expect(t.cost.state).toBe("ok");
    expect(t.tools.state).toBe("ok");
    expect(t.errors.state).toBe("ok");
    if (t.errors.state === "ok") expect(t.errors.data[0].msg).toBe("boom");
  });

  // Correlations must not include rows from a different session.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-032
  it("excludes other sessions", () => {
    errors.prepare("INSERT INTO error_event VALUES (?,?,?,?,?,?)")
      .run(1005, 50, "api", "mine", "", JSON.stringify({ sessionId: SESSION }));
    errors.prepare("INSERT INTO error_event VALUES (?,?,?,?,?,?)")
      .run(1006, 50, "api", "theirs", "", JSON.stringify({ sessionId: "other" }));

    const t = traceSession(SESSION, { usage, errors, requests });
    if (t.errors.state !== "ok") throw new Error("expected ok");
    expect(t.errors.data.map((e) => e.msg)).toEqual(["mine"]);
  });

  // Unreadable evidence is unavailable rather than a successful report of no errors.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-033
  it("distinguishes an empty result from an absent store", () => {
    usage.prepare("INSERT INTO session_usage VALUES (?,?,?,?,?,?)").run(SESSION, "opus", 1, 0, 0, 1000);
    const t = traceSession(SESSION, { usage, errors, requests: null });
    expect(t.errors.state).toBe("empty");
    expect(t.requestsInWindow.state).toBe("unavailable");
  });

  /** A broken store reports why, rather than looking like a quiet one. */
  it("reports a read failure as unavailable", () => {
    errors.exec("DROP TABLE error_event");
    const t = traceSession(SESSION, { usage, errors, requests });
    expect(t.errors.state).toBe("unavailable");
    if (t.errors.state === "unavailable") expect(t.errors.reason).toMatch(/errors\.db/);
  });

  // Without a recorded session window, time-only request correlation cannot attribute unrelated traffic.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-034
  it("refuses to window requests when the session has no usage rows", () => {
    errors.prepare("INSERT INTO error_event VALUES (?,?,?,?,?,?)")
      .run(1005, 50, "api", "boom", "", JSON.stringify({ sessionId: SESSION }));
    const t = traceSession(SESSION, { usage, errors, requests });
    expect(t.requestsInWindow.state).toBe("unavailable");
    expect(t.window).toBeUndefined();
  });

  // Mark capped correlation results as partial so a sample does not look complete.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-035
  it("reports truncation as partial rather than ok", () => {
    usage.prepare("INSERT INTO session_usage VALUES (?,?,?,?,?,?)").run(SESSION, "opus", 1, 0, 0, 1000);
    const ins = usage.prepare("INSERT INTO tool_invocation VALUES (?,?,?,?)");
    for (let i = 0; i < 5; i++) ins.run(SESSION, "Bash", 1, 1000 + i);

    const t = traceSession(SESSION, { usage, errors, requests }, 3);
    expect(t.tools.state).toBe("partial");
    if (t.tools.state === "partial") {
      expect(t.tools.data).toHaveLength(3);
      expect(t.tools.caveat).toMatch(/most recent 3 tool calls/);
    }
  });
});
