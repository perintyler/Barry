import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import type { ProcessRecord, SessionRecord } from "@barry-rocks/sessions-bag/client";
import { shippedVendors } from "./test-helpers/shipped-vendors.js";

const VENDORS = await shippedVendors();
import { findInstalled } from "@barry-rocks/sdk/adapters/harnesses";
import { createModels, installModels } from "@barry-rocks/sdk/adapters/models";
import { setAgentRuntime } from "./agent-runtime.js";
import { serializeSession } from "./session-serialize.js";
import { SHIPPED_HARNESSES } from "./test-helpers/shipped-harnesses.js";

function makeRecord(metadata: Record<string, unknown>): SessionRecord {
  return {
    id: "sess-1",
    active: true,
    state: "open",
    user_id: null,
    agent_token: null,
    identity_id: null,
    workflow_credential_id: null,
    status: "running",
    system_prompt: "do the thing",
    summary: null,
    traits: [],
    bound: null,
    bounds: [], bound_id: null,
    metadata: metadata,
    created_at: "2026-07-24T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    ended_at: null,
    last_message_at: null,
  };
}

function makeProgress(title: string, data: Record<string, unknown> = {}) {
  return { title, data, created_at: new Date("2026-07-24T02:40:42.332Z") };
}

describe("serializeSession — statusUpdate", () => {
  it("derives statusUpdate from the session's latest progress event", () => {
    const out = serializeSession(
      makeRecord({}),
      null,
      undefined,
      makeProgress("CI passed, merging", { phase: "complete" }),
    );
    expect(out.statusUpdate).toEqual({
      summary: "CI passed, merging",
      phase: "complete",
      updatedAt: "2026-07-24T02:40:42.332Z",
    });
  });

  it("is null when the session has no progress event", () => {
    const out = serializeSession(makeRecord({ working_directory: "/repo" }), null);
    expect(out.statusUpdate).toBeNull();
  });

  it("nulls the phase when the event carries no phase", () => {
    const out = serializeSession(makeRecord({}), null, undefined, makeProgress("Still working"));
    expect(out.statusUpdate).toEqual({
      summary: "Still working",
      phase: null,
      updatedAt: "2026-07-24T02:40:42.332Z",
    });
  });

  it("ignores leftover status fields in metadata — events are the only source", () => {
    // Sessions predating the events migration may still carry these keys.
    const out = serializeSession(makeRecord({
      summary: "stale metadata summary",
      phase: "building",
      status_updated_at: "2026-07-01T00:00:00.000Z",
    }), null);
    expect(out.statusUpdate).toBeNull();
  });

  it("does not confuse the top-level summary column with the progress event", () => {
    // record.summary is the auto-generated column owned by the session
    // summarizer — unrelated to progress events.
    const record = { ...makeRecord({}), summary: "auto-generated summary" };
    const out = serializeSession(record, null);
    expect(out.summary).toBe("auto-generated summary");
    expect(out.statusUpdate).toBeNull();
  });
});

describe("serializeSession — status reconciliation", () => {
  const closed = (status: SessionRecord["status"]): SessionRecord => ({
    ...makeRecord({}),
    status,
    active: false,
    state: "closed",
  });

  it("returns an open session's stored status untouched when liveness is unknown", () => {
    // An unknown answer must not be reported as a confident one.
    expect(serializeSession(makeRecord({}), null).status).toBe("running");
  });

  it("still reports a closed session as terminal when liveness is unknown", () => {
    // Closure is authoritative on its own: `active=false`/`state=closed` is a
    // recorded fact about the row, so it needs no corroboration from the live
    // set. Reporting a closed row as `pending` would resurrect a dead session.
    expect(serializeSession(closed("pending"), null).status).toBe("completed");
  });

  it("keeps a stored 'running' when it is merely absent from the live set", () => {
    // Regression: `isLive` comes from the API's in-memory sessionRuntime, which only
    // tracks sessions it spawned. A CLI session — how nearly every session here
    // starts — is never in that map even while it is actively streaming, so
    // demoting on absence painted live sessions orange in the macOS app.
    // Retiring a truly stale `running` is markCrashedSessions' job; it closes
    // the row, which the `closed` branch below reports as terminal.
    expect(serializeSession(makeRecord({}), null, undefined, undefined, false).status).toBe("running");
  });

  it("reports a crashed session as terminal once the sweep has closed its row", () => {
    // The crash path end to end: markCrashedSessions sets active=false/state=closed,
    // and that — not an empty live-set lookup — is what makes the status terminal.
    expect(serializeSession(closed("running"), null, undefined, undefined, false).status).toBe("completed");
  });

  it("promotes a live session resting at 'pending' to 'running'", () => {
    const record = { ...makeRecord({}), status: "pending" as const };
    expect(serializeSession(record, null, undefined, undefined, true).status).toBe("running");
  });

  it("reports a closed session as terminal even when stored as pending", () => {
    // The endSession regression: active=false + state=closed but status frozen.
    expect(serializeSession(closed("pending"), null, undefined, undefined, false).status).toBe("completed");
  });

  it("preserves a closed session's real terminal outcome", () => {
    expect(serializeSession(closed("cancelled"), null, undefined, undefined, false).status).toBe("cancelled");
    expect(serializeSession(closed("failed"), null, undefined, undefined, false).status).toBe("failed");
  });

  it("treats closure as authoritative over a stale live-set entry", () => {
    // A stopped session can briefly remain in the in-memory map; the DB's
    // closed state is the stronger signal.
    expect(serializeSession(closed("pending"), null, undefined, undefined, true).status).toBe("completed");
  });
});

describe("serializeSession — harness and model", () => {
  const records = [SHIPPED_HARNESSES["claude-code"], SHIPPED_HARNESSES["opencode"]];
  beforeAll(() => {
    installModels(createModels(VENDORS));
    setAgentRuntime({ createSession: vi.fn(), runStructured: vi.fn(), describeAdapter: (id) => findInstalled(records, id) });
  });
  afterAll(() => setAgentRuntime({ createSession: vi.fn(), runStructured: vi.fn() }));

  it("keeps the provider clients read, and names the harness by its id now", () => {
    const out = serializeSession(makeRecord({ provider: "claude", model: "claude-opus-5" }), null);
    expect(out).toMatchObject({ provider: "claude", harness: "claude-code", model: "claude-opus-5", modelRef: "anthropic/claude-opus-5" });
  });

  it("names a routed model's vendor, and says nothing it does not know", () => {
    expect(serializeSession(makeRecord({ provider: "claude", model: "glm-5.2", model_provider: "zai" }), null).modelRef).toBe("zai/glm-5.2");
    // opencode connects itself, so a bare id names no vendor.
    expect(serializeSession(makeRecord({ provider: "opencode", model: "smollm2" }), null).modelRef).toBeNull();
    expect(serializeSession(makeRecord({ provider: "opencode", model: "ollama/smollm2" }), null).modelRef).toBe("ollama/smollm2");
    expect(serializeSession(makeRecord({}), null).harness).toBeNull();
  });
});

it("serializes session branch, transcript and process metadata", () => {
  expect(serializeSession(makeRecord({ git_branch: "feature", transcript_path: "/scratch/transcript", hostname: "mac", pid: 42, pid_started_at: 1700000000 }), null))
    .toMatchObject({ branch: "feature", transcriptPath: "/scratch/transcript", hostname: "mac", pid: 42, pidStartedAt: 1700000000 });
});

it("takes the process from the session's live process row over its metadata", () => {
  // Since the store migration the CLI's pid reaches only the processes table.
  const live: ProcessRecord = {
    id: 9, sessionId: "sess-1", pid: 4242, pidStartedAt: 1700000500, hostname: "mac", processName: "node", command: null,
    appName: "claude", parentPid: null, source: "cli", startedAt: "2026-10-01T00:00:00.000Z", endedAt: null,
    lastCheckedAt: null, liveness: null, livenessReason: null,
  };
  expect(serializeSession(makeRecord({}), live)).toMatchObject({ hostname: "mac", pid: 4242, pidStartedAt: 1700000500 });
  expect(serializeSession(makeRecord({ hostname: "old", pid: 42, pid_started_at: 1700000000 }), { ...live, hostname: null }))
    .toMatchObject({ hostname: null, pid: 4242, pidStartedAt: 1700000500 });
});

it("nulls missing metadata and pids recorded as strings", () => {
  expect(serializeSession(makeRecord({ pid: "42", pid_started_at: "1700000000" }), null))
    .toMatchObject({ branch: null, transcriptPath: null, hostname: null, pid: null, pidStartedAt: null });
});
