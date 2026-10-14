import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@barry-rocks/sdk/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/services")>(),
  getServicePort: () => 4885,
}));
vi.mock("@barry-rocks/identities-bag", () => ({
  identityRecords: { find: vi.fn(), rowId: vi.fn() },
}));
vi.mock("../lib/current-user.js", () => ({ getActiveIdentity: vi.fn(), getCurrentUser: vi.fn() }));

const { ApiSessions } = await import("./acp.js");
const interruptEvents = [
  { type: "TOOL_CALL_START", toolCallId: "call-one", toolCallName: "write", parentMessageId: "run:assistant" },
  { type: "TOOL_CALL_ARGS", toolCallId: "call-one", delta: JSON.stringify({ path: "one.txt" }) },
  { type: "TOOL_CALL_END", toolCallId: "call-one" },
  { type: "TOOL_CALL_START", toolCallId: "call-two", toolCallName: "write", parentMessageId: "run:assistant" },
  { type: "TOOL_CALL_ARGS", toolCallId: "call-two", delta: JSON.stringify({ path: "two.txt" }) },
  { type: "TOOL_CALL_END", toolCallId: "call-two" },
  { type: "RUN_FINISHED", threadId: "session", runId: "run", outcome: { type: "interrupt", interrupts: [
    { id: "interrupt-one", reason: "tool_call", toolCallId: "call-one", message: "Allow write?", responseSchema: { type: "object" } },
    { id: "interrupt-two", reason: "tool_call", toolCallId: "call-two", message: "Allow write?", responseSchema: { type: "object" } },
  ] } },
];
const resumeEvents = [
  { type: "TOOL_CALL_RESULT", toolCallId: "call-one", messageId: "result-one", role: "tool", content: "ok" },
  { type: "TOOL_CALL_RESULT", toolCallId: "call-two", messageId: "result-two", role: "tool", content: "ok" },
  { type: "RUN_FINISHED", threadId: "session", runId: "resume" },
];
const sse = (events: unknown[], firstSequence = 1) => new Response(events.map((event, index) => `id: ${firstSequence + index}:0\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

function snapshot(state: "running" | "waiting_for_input" | "completed") {
  const pending = state === "waiting_for_input";
  return {
    threadId: "session", cursor: pending ? 9 : state === "completed" ? 12 : 0, messages: [],
    turn: state === "running" ? null : {
      id: "turn", sessionId: "session", runId: pending ? "run" : "resume", state, revision: pending ? 2 : 3,
      reviewPolicy: { mode: "review_required" },
      interrupts: [
        { id: "interrupt-one", runId: "run", call: { id: "call-one", tool: "write", input: { path: "one.txt" } }, status: pending ? "pending" : "approved" },
        { id: "interrupt-two", runId: "run", call: { id: "call-two", tool: "write", input: { path: "two.txt" } }, status: pending ? "pending" : "denied" },
      ],
    },
    protocolVersion: "1.0", appExtensionVersion: 2, agUiPackageVersion: "1.0.1",
    capabilities: { approvalContinuation: "durable", frontendTools: false, approveWithEdits: false, attachments: true, replay: true },
  };
}

describe("ACP adapter over AG-UI", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits for a complete approval batch and resumes the same session turn", async () => {
    let state: "running" | "waiting_for_input" | "completed" = "running";
    let acceptedMessages: unknown[] = [];
    const requests: Array<{ resume?: unknown; messages: Array<{ role: string }> }> = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v2/sessions/session") && !init?.method) return Response.json({ ...snapshot(state), messages: acceptedMessages });
      if (url.endsWith("/api/v2/sessions/session/ag-ui")) {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        if (body.resume) { state = "completed"; return sse(resumeEvents, 8); }
        acceptedMessages = body.messages;
        state = "waiting_for_input"; return sse(interruptEvents);
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fakeFetch);
    const sessions = new ApiSessions({ apiPort: 4885 });
    const events: Array<{ type: string; requestId?: string; toolUseId?: string }> = [];
    let notifyApproval!: () => void;
    const approval = new Promise<void>((resolve) => { notifyApproval = resolve; });
    const prompt = sessions.prompt("session", "write both files", (event) => {
      events.push(event);
      if (event.type === "permission_request" && events.filter((item) => item.type === "permission_request").length === 2) notifyApproval();
    });
    await approval;
    const first = await sessions.ruling("session", "interrupt-one", "allow");
    expect(first).toBeUndefined();
    expect(requests).toHaveLength(1);
    await sessions.ruling("session", "interrupt-two", "deny", "not this file");
    await prompt;
    expect(requests).toHaveLength(2);
    expect(requests[1]?.resume).toEqual([
      { interruptId: "interrupt-one", status: "resolved", payload: { approved: true } },
      { interruptId: "interrupt-two", status: "resolved", payload: { approved: false, reason: "not this file" } },
    ]);
    expect(requests[1]?.messages.filter((message: { role: string }) => message.role === "user")).toEqual(requests[0]?.messages);
    expect(events.filter((event) => event.type === "permission_request").map((event) => event.requestId)).toEqual(["interrupt-one", "interrupt-two"]);
    expect(events.filter((event) => event.type === "tool_start").map((event) => event.toolUseId)).toEqual(["call-one", "call-two"]);
    sessions.close();
  });
});
