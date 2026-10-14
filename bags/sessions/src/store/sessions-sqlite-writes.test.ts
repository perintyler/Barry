import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "./session-records.js";

/**
 * SQLite writes, checked by reading back what a caller would see.
 *
 * The cases that matter are the ones where the write is not a plain column
 * assignment — a status that must be preserved when terminal, a completion
 * time that must not be overwritten, a metadata merge that must not clobber
 * its siblings. Those rules are invisible in the column list and were each got
 * wrong in a first draft. Clock fields are compared by presence only.
 */
process.env.BARRY_SESSIONS_DB = join(mkdtempSync(join(tmpdir(), "barry-sqw-")), "sessions.db");

const { getSessionsSqlite, closeSessionsDb } = await import("./sessions-db.js");
const {
  createSessionSqlite,
  updateSessionSqlite,
  updateSessionMetadataSqlite,
  endSessionSqlite,
  issueWorkflowCredentialSqlite,
  archiveSessionSqlite,
  deleteSessionSqlite,
  createProviderSessionSqlite,
  endProviderSessionByProviderIdSqlite,
  markCrashedSessionsSqlite,
  archiveAllClosedSessionsSqlite,
  createNamedSessionSqlite,
  createInertSessionSqlite,
  maxMessageSequenceSqlite,
  appendMessageSqlite,
} = await import("./sessions-sqlite-writes.js");
const { getSessionSqlite } = await import("./sessions-sqlite-reads.js");

const PREFIX = "zz-sqw-";
const ID = `${PREFIX}s1`;

function seed(id = ID, overrides: Record<string, unknown> = {}): void {
  createSessionSqlite({
    id,
    agent_token: "agt_test",
    metadata: { working_directory: "/tmp", name: "Write Test" },
    ...overrides,
  });
}

/**
 * `seed()` read back, with `created_at` blanked because it is a clock read.
 * Everything else is a default: active, open, pending, no traits, no bound.
 */
const EXPECTED_CREATED: SessionRecord = {
  id: ID,
  active: true,
  state: "open",
  user_id: null,
  agent_token: "agt_test",
  identity_id: null,
  workflow_credential_id: null,
  status: "pending",
  system_prompt: null,
  summary: null,
  traits: [],
  bound: null,
  bounds: [], bound_id: null,
  metadata: { name: "Write Test", working_directory: "/tmp" },
  created_at: "",
  started_at: null,
  completed_at: null,
  ended_at: null,
  last_message_at: null,
};

beforeAll(() => {
  getSessionsSqlite();
});

beforeEach(() => {
  getSessionsSqlite().exec("DELETE FROM provider_sessions; DELETE FROM messages; DELETE FROM sessions");
});

afterAll(() => {
  closeSessionsDb();
});

describe("createSession", () => {
  it("writes the whole record a caller reads back", () => {
    seed();

    const lite = getSessionSqlite(ID);

    expect({ ...lite, created_at: "" }).toEqual(EXPECTED_CREATED);
    expect(lite?.created_at).not.toBe("");
  });

  it("defaults active, state and status", () => {
    seed();
    const s = getSessionSqlite(ID);
    expect(s?.active).toBe(true);
    expect(s?.state).toBe("open");
    expect(s?.status).toBe("pending");
  });

  it("stores JSON columns as text that reads back as objects", () => {
    seed(`${PREFIX}json`, { traits: ["a", "b"], bound: { kind: "repo" } });
    const s = getSessionSqlite(`${PREFIX}json`);
    // An object bound directly would throw in better-sqlite3; this asserts the
    // serialisation happened AND round-trips.
    expect(s?.traits).toEqual(["a", "b"]);
    expect(s?.bound).toEqual({ kind: "repo" });
  });
});

describe("updateSession", () => {
  beforeEach(() => {
    seed();
  });

  it("leaves untouched columns alone", () => {
    updateSessionSqlite(ID, { summary: "new summary" });
    const s = getSessionSqlite(ID);
    expect(s?.summary).toBe("new summary");
    // system_prompt was never supplied, so it must still be null rather than
    // having been overwritten with undefined.
    expect(s?.system_prompt).toBeNull();
    expect(s?.metadata.name).toBe("Write Test");
  });

  it("stamps completed_at when moving to a terminal status", () => {
    endSessionSqlite(ID);
    updateSessionSqlite(ID, { completed_at: null });
    updateSessionSqlite(ID, { status: "completed" });
    expect(getSessionSqlite(ID)?.completed_at).not.toBeNull();
  });

  it("does not stamp completed_at for a non-terminal status", () => {
    updateSessionSqlite(ID, { status: "running" });
    expect(getSessionSqlite(ID)?.completed_at).toBeNull();
  });

  it("records a failure as terminal, with a completion time", () => {
    endSessionSqlite(ID);
    updateSessionSqlite(ID, { status: "failed" });
    const lite = getSessionSqlite(ID);
    expect(lite?.status).toBe("failed");
    expect(lite?.completed_at).not.toBeNull();
  });

  it("returns the current record for an empty patch without writing", () => {
    const before = getSessionSqlite(ID);
    expect(updateSessionSqlite(ID, {})).toEqual(before);
  });
});

describe("metadata merge", () => {
  beforeEach(() => seed());

  it("merges keys instead of replacing the object", () => {
    updateSessionMetadataSqlite(ID, { git_branch: "main" });
    const m = getSessionSqlite(ID)?.metadata;
    // The whole point: an assignment here would drop working_directory and
    // name, which is how a session loses its identity mid-run.
    expect(m?.git_branch).toBe("main");
    expect(m?.working_directory).toBe("/tmp");
    expect(m?.name).toBe("Write Test");
  });

  it("overwrites a key that already exists", () => {
    updateSessionMetadataSqlite(ID, { name: "renamed" });
    expect(getSessionSqlite(ID)?.metadata.name).toBe("renamed");
  });
});

describe("endSession", () => {
  beforeEach(() => {
    seed();
  });

  it("closes the session and stamps ended_at", () => {
    endSessionSqlite(ID);
    const s = getSessionSqlite(ID);
    expect(s?.active).toBe(false);
    expect(s?.state).toBe("closed");
    expect(s?.ended_at).not.toBeNull();
  });

  it("replaces a non-terminal status rather than leaving it live", () => {
    // Left alone, status stays "pending" and every consumer reading the column
    // still sees the session as live.
    endSessionSqlite(ID);
    expect(getSessionSqlite(ID)?.status).toBe("completed");
  });

  it("PRESERVES a terminal status the caller already set", () => {
    // The real outcome — cancelled by a discard, failed by an error — must
    // survive being closed.
    endSessionSqlite(ID);
    updateSessionSqlite(ID, { status: "cancelled" });
    endSessionSqlite(ID);
    expect(getSessionSqlite(ID)?.status).toBe("cancelled");
  });

  it("preserves a failure through closing, too", () => {
    endSessionSqlite(ID);
    updateSessionSqlite(ID, { status: "failed" });
    endSessionSqlite(ID);
    expect(getSessionSqlite(ID)?.status).toBe("failed");
  });

  it("merges end_reason without dropping the rest of metadata", () => {
    endSessionSqlite(ID, "user quit");
    const m = getSessionSqlite(ID)?.metadata;
    expect(m?.end_reason).toBe("user quit");
    expect(m?.working_directory).toBe("/tmp");
  });
});

describe("deleteSession", () => {
  it("cascades to messages, which requires foreign_keys=ON", () => {
    seed();
    getSessionsSqlite()
      .prepare(
        "INSERT INTO messages (id, session_id, type, sequence, role, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(`${ID}-m1`, ID, "message", 1, "user", "2026-09-22T05:00:00.000Z");

    deleteSessionSqlite(ID);

    // The FK is real here, but only because the pragma is set per connection.
    // Without it SQLite ignores the constraint and leaves orphans silently.
    const orphans = getSessionsSqlite()
      .prepare("SELECT count(*) c FROM messages WHERE session_id = ?")
      .get(ID) as { c: number };
    expect(orphans.c).toBe(0);
    expect(getSessionSqlite(ID)).toBeUndefined();
  });
});

describe("provider sessions", () => {
  beforeEach(() => seed());

  it("creates and then ends one by its provider id", () => {
    createProviderSessionSqlite({ session_id: ID, provider: "claude", provider_session_id: "p-1" });
    const before = getSessionsSqlite()
      .prepare("SELECT ended_at FROM provider_sessions WHERE provider_session_id = ?")
      .get("p-1") as { ended_at: string | null };
    expect(before.ended_at).toBeNull();

    endProviderSessionByProviderIdSqlite("p-1");
    const after = getSessionsSqlite()
      .prepare("SELECT ended_at FROM provider_sessions WHERE provider_session_id = ?")
      .get("p-1") as { ended_at: string | null };
    expect(after.ended_at).not.toBeNull();
  });

  it("does not re-end an already-ended provider session", () => {
    createProviderSessionSqlite({ session_id: ID, provider: "claude", provider_session_id: "p-2" });
    endProviderSessionByProviderIdSqlite("p-2");
    const first = getSessionsSqlite()
      .prepare("SELECT ended_at FROM provider_sessions WHERE provider_session_id = ?")
      .get("p-2") as { ended_at: string };

    endProviderSessionByProviderIdSqlite("p-2");
    const second = getSessionsSqlite()
      .prepare("SELECT ended_at FROM provider_sessions WHERE provider_session_id = ?")
      .get("p-2") as { ended_at: string };
    // `AND ended_at IS NULL` in the update is what makes this idempotent; a
    // second call must not move the recorded end time forward.
    expect(second.ended_at).toBe(first.ended_at);
  });
});

describe("markCrashedSessions", () => {
  const OLD = "2020-01-01T00:00:00.000Z";

  it("closes a session whose last message is older than the cutoff", () => {
    seed();
    const sqlite = getSessionsSqlite();
    sqlite
      .prepare(
        "INSERT INTO messages (id, session_id, type, sequence, role, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(`${ID}-m1`, ID, "message", 1, "user", OLD);

    expect(markCrashedSessionsSqlite(60_000)).toBe(1);
    expect(getSessionSqlite(ID)?.active).toBe(false);
  });

  it("leaves a session with a RECENT message alone", () => {
    seed();
    getSessionsSqlite()
      .prepare(
        "INSERT INTO messages (id, session_id, type, sequence, role, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(`${ID}-m1`, ID, "message", 1, "user", new Date().toISOString());

    expect(markCrashedSessionsSqlite(60_000)).toBe(0);
    expect(getSessionSqlite(ID)?.active).toBe(true);
  });

  it("closes an EMPTY session on the short cutoff, not the long one", () => {
    // THE AGE HERE IS THE WHOLE TEST. It must sit BETWEEN the two cutoffs:
    // older than EMPTY_SESSION_IDLE_MS (30 min) so the empty-session rule
    // closes it, but NEWER than the 24h idle window so the general rule does
    // not. Two hours satisfies both.
    //
    // A very old timestamp (2020, as an earlier version of this used) is past
    // BOTH cutoffs, so it cannot tell the two rules apart — verified by
    // collapsing them into a single COALESCE comparison in the source, which
    // left that version green. With the age below, the same break turns this
    // red.
    seed();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    getSessionsSqlite().prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run(twoHoursAgo, ID);

    expect(markCrashedSessionsSqlite(24 * 60 * 60 * 1000)).toBe(1);
    expect(getSessionSqlite(ID)?.active).toBe(false);
  });

  it("preserves a terminal status while closing", () => {
    seed();
    endSessionSqlite(ID);
    updateSessionSqlite(ID, { status: "failed" });
    // A terminal session cannot be reopened by a crash fixture or production writer.
    expect(() => getSessionsSqlite().prepare("UPDATE sessions SET created_at = ?, active = 1 WHERE id = ?").run(OLD, ID)).toThrow(/terminal session must be closed/);

    markCrashedSessionsSqlite(60_000);
    expect(getSessionSqlite(ID)?.status).toBe("failed");
  });

  it("honours excludeIds", () => {
    seed();
    getSessionsSqlite().prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run(OLD, ID);

    expect(markCrashedSessionsSqlite(60_000, [ID])).toBe(0);
    expect(getSessionSqlite(ID)?.active).toBe(true);
  });
});

describe("archiveAllClosedSessions", () => {
  it("archives closed sessions and leaves open ones", () => {
    seed(`${PREFIX}open`);
    seed(`${PREFIX}closed`);
    endSessionSqlite(`${PREFIX}closed`);

    expect(archiveAllClosedSessionsSqlite()).toBe(1);
    expect(getSessionSqlite(`${PREFIX}closed`)?.state).toBe("archived");
    expect(getSessionSqlite(`${PREFIX}open`)?.state).toBe("open");
  });
});

describe("the two session creators", () => {
  it("persists the selected user for named and inert sessions and rejects invalid attribution", () => {
    for (const [suffix, create] of [["named", createNamedSessionSqlite], ["inert", createInertSessionSqlite]] as const) {
      const id = `${PREFIX}owner-${suffix}`;
      expect(create({ id, agent_token: null, user_id: 2 }).user_id).toBe(2);
      expect(getSessionSqlite(id)?.user_id).toBe(2);
      for (const user_id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => create({ id: `${id}-invalid`, agent_token: null, user_id })).toThrow("positive actor ID");
        expect(getSessionSqlite(`${id}-invalid`)).toBeUndefined();
      }
    }
  });
  it("creates an inactive session and returns the stored row", () => {
    const s = createNamedSessionSqlite({
      id: `${PREFIX}plan`,
      agent_token: "agt_test",
      system_prompt: "do the thing",
    });
    expect(s.id).toBe(`${PREFIX}plan`);
    expect(s.active).toBe(false);
    expect(s.status).toBe("pending");
    expect(s.started_at).toBeNull();
    // Returned by reading the row back, so it reflects the actual defaults
    // rather than a hand-built object.
    expect(s).toEqual(getSessionSqlite(`${PREFIX}plan`));
  });

  it("derives a session name from the system prompt", () => {
    const s = createNamedSessionSqlite({
      id: `${PREFIX}p2`,
      agent_token: null,
      system_prompt: "fix the broken migration",
    });
    expect(s.metadata.name).toBeTruthy();
    expect(String(s.metadata.name).toLowerCase()).toContain("migration");
  });

  it("does NOT derive an inert session's name from the system prompt", () => {
    // The single behavioural difference between the two creators, and the whole
    // reason both still exist after the draft concept was removed: collapsing
    // them into one function with a flag would give inert rows derived names.
    const s = createInertSessionSqlite({
      id: `${PREFIX}d1`,
      agent_token: null,
      system_prompt: "fix the broken migration",
    });
    expect(s.metadata.name).toBeUndefined();
  });

  it("keeps an explicit name on both", () => {
    const p = createNamedSessionSqlite({
      id: `${PREFIX}p3`, agent_token: null, system_prompt: "ignored", metadata: { name: "My Name" },
    });
    const d = createInertSessionSqlite({
      id: `${PREFIX}d2`, agent_token: null, system_prompt: "ignored", metadata: { name: "My Name" },
    });
    expect(p.metadata.name).toBe("My Name");
    expect(d.metadata.name).toBe("My Name");
  });
});

describe("maxMessageSequence", () => {
  it("returns -1 for a session with no messages", () => {
    seed();
    // -1, not 0: the next sequence is current + 1, and the first message must
    // be sequence 0. Returning 0 here would skip it.
    expect(maxMessageSequenceSqlite(ID)).toBe(-1);
  });

  it("returns the highest sequence present", () => {
    seed();
    const insert = getSessionsSqlite().prepare(
      "INSERT INTO messages (id, session_id, type, sequence, role, created_at) VALUES (?,?,?,?,?,?)",
    );
    insert.run(`${ID}-a`, ID, "message", 0, "user", "2026-09-22T05:00:00.000Z");
    insert.run(`${ID}-b`, ID, "message", 7, "user", "2026-09-22T05:01:00.000Z");
    expect(maxMessageSequenceSqlite(ID)).toBe(7);
  });
});

describe("message persistence", () => {
  beforeEach(() => seed());

  const rows = () =>
    getSessionsSqlite()
      .prepare("SELECT id, type, sequence, role, name, content, input, result, metadata FROM messages ORDER BY sequence")
      .all() as Array<Record<string, string | null>>;

  it("persists a text message through the shared protocol switch", async () => {
    expect(await appendMessageSqlite(ID, { type: "text", role: "assistant", content: "hello" } as never)).toBe(0);
    const [r] = rows();
    expect(r.type).toBe("message");
    expect(r.role).toBe("assistant");
    // Content arrives as an OBJECT from persistOne and must land as JSON text
    // — this is the whole reason the json plugin exists.
    expect(JSON.parse(r.content as string)).toEqual([{ type: "text", text: "hello" }]);
    expect(JSON.parse(r.metadata as string).ws_type).toBe("text");
  });

  it("folds a tool_result into its call's row and stores no row of its own", async () => {
    expect(await appendMessageSqlite(ID, { type: "tool_start", name: "Bash", toolUseId: "t1", input: { cmd: "ls" } })).toBe(0);
    expect(await appendMessageSqlite(ID, { type: "tool_result", toolUseId: "t1", result: "ok" })).toBeNull();

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe("tool_call");
    expect(all[0].result).toBe("ok");
    expect(JSON.parse(all[0].input as string)).toEqual({ cmd: "ls" });
  });
});


describe("workflow run credentials", () => {
  const expected = { actorId: 11, identityId: 22, scopeFingerprint: "a".repeat(64) };
  function workflowSession(): void {
    seed(ID, { user_id: 11, identity_id: 22, metadata: {
      name: "Workflow", workflow_identity_id: 22,
      workflow_scope: { fingerprint: expected.scopeFingerprint },
    } });
  }

  it("rotates atomically and refuses stale ownership, scope or missing sessions", () => {
    workflowSession();
    const first = issueWorkflowCredentialSqlite(ID, expected);
    const second = issueWorkflowCredentialSqlite(ID, expected);
    expect(first).toMatch(/^[a-f0-9-]{36}$/);
    expect(second).not.toBe(first);
    expect(getSessionSqlite(ID)?.workflow_credential_id).toBe(second);
    for (const stale of [{ ...expected, actorId: 12 }, { ...expected, identityId: 23 }, { ...expected, scopeFingerprint: "b".repeat(64) }]) {
      expect(issueWorkflowCredentialSqlite(ID, stale)).toBeNull();
      expect(getSessionSqlite(ID)?.workflow_credential_id).toBe(second);
    }
    expect(issueWorkflowCredentialSqlite("missing", expected)).toBeNull();
  });

  it.each([undefined, "finished"])("end and resume cannot restore the previous run (%s)", reason => {
    workflowSession();
    const first = issueWorkflowCredentialSqlite(ID, expected);
    endSessionSqlite(ID, reason);
    expect(getSessionSqlite(ID)?.workflow_credential_id).toBeNull();
    expect(issueWorkflowCredentialSqlite(ID, expected)).toBeNull();
    updateSessionSqlite(ID, { status: "pending", state: "open", ended_at: null });
    updateSessionMetadataSqlite(ID, { workflow_credential_id: first });
    expect(getSessionSqlite(ID)?.workflow_credential_id).toBeNull();
    const resumed = issueWorkflowCredentialSqlite(ID, expected);
    expect(resumed).not.toBeNull();
    expect(resumed).not.toBe(first);
  });

  it.each(["archive", "crashed", "closed", "ended", "actor", "identity", "scope", "scopeIdentity"])("revokes on %s changes, even through direct SQL", change => {
    workflowSession();
    expect(issueWorkflowCredentialSqlite(ID, expected)).not.toBeNull();
    const sqlite = getSessionsSqlite();
    if (change === "archive") archiveSessionSqlite(ID);
    if (change === "crashed") {
      sqlite.prepare("UPDATE sessions SET created_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", ID);
      expect(markCrashedSessionsSqlite(1)).toBe(1);
    }
    if (change === "closed") updateSessionSqlite(ID, { state: "closed" });
    if (change === "ended") updateSessionSqlite(ID, { ended_at: new Date() });
    if (change === "actor") sqlite.prepare("UPDATE sessions SET user_id = 12 WHERE id = ?").run(ID);
    if (change === "identity") updateSessionSqlite(ID, { identity_id: 23 });
    if (change === "scope") updateSessionMetadataSqlite(ID, { workflow_scope: { fingerprint: "b".repeat(64) } });
    if (change === "scopeIdentity") updateSessionMetadataSqlite(ID, { workflow_identity_id: 23 });
    expect(getSessionSqlite(ID)?.workflow_credential_id).toBeNull();
    sqlite.prepare("UPDATE sessions SET status = 'pending', state = 'open', ended_at = NULL, user_id = 11, identity_id = 22 WHERE id = ?").run(ID);
    updateSessionMetadataSqlite(ID, { workflow_identity_id: 22, workflow_scope: { fingerprint: expected.scopeFingerprint } });
    expect(getSessionSqlite(ID)?.workflow_credential_id).toBeNull();
  });

  it("keeps authority for ordinary metadata changes and rejects credential injection", () => {
    workflowSession();
    const credentialId = issueWorkflowCredentialSqlite(ID, expected);
    updateSessionMetadataSqlite(ID, { name: "Renamed", workflow_credential_id: "injected" });
    updateSessionSqlite(ID, { workflow_credential_id: "injected" } as Parameters<typeof updateSessionSqlite>[1]);
    expect(getSessionSqlite(ID)?.workflow_credential_id).toBe(credentialId);
  });
});
