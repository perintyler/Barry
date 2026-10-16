import { describe, expect, it } from "vitest";
import { AgentEventSchema, CreateSessionRequestSchema, MessageListResponseSchema, UpdateSessionRequestSchema } from "./types.js";
import { ProblemDetailsSchema } from "../errors.js";

describe("Session schemas", () => {
  it("rejects unknown request fields", () => {
    expect(CreateSessionRequestSchema.safeParse({ systemPrompt: "hello", unexpectedField: true }).success).toBe(false);
  });

  /**
   * The boundary validates the SHAPE of a provider id, not its membership.
   *
   * This asserted `provider: "unknown"` was rejected — true while
   * `ProviderIdSchema` (now `HarnessIdSchema`) was a closed enum, and exactly what made a third-party
   * adapter impossible to record. The id set is open now (ruling D.4); whether
   * an adapter is INSTALLED is answered by the `agent_adapters` foreign key,
   * at the point where installation is recorded.
   *
   * So a well-formed id for an adapter nobody has installed passes here and is
   * refused at the write — and the boundary still rejects an id that could
   * never be one, because these reach filesystem paths and CLI flags.
   */
  it("validates the shape of a provider id at the boundary", () => {
    const parse = (provider: string) =>
      AgentEventSchema.safeParse({ type: "sessionStarted", sessionId: "s1", provider }).success;

    expect(parse("codex")).toBe(true);
    expect(parse("cursor")).toBe(true);
    // A syntactically valid third-party adapter identifier is accepted.
    // Rationale: docs/decisions/0032-sdk-contract-regression-history.md.
    expect(parse("aider")).toBe(true);

    // Still refused — none of these can be a directory name or a CLI flag:
    expect(parse("")).toBe(false);
    expect(parse("../etc/passwd")).toBe(false);
    expect(parse("Cursor")).toBe(false);
    expect(parse("has space")).toBe(false);
  });

  it("validates the session message event stream", () => {
    const response = MessageListResponseSchema.parse({
      messages: [{
        type: "tool_start",
        sessionId: "session-1",
        name: "Edit",
        input: { file_path: "/tmp/example.ts" },
        result: null,
        hasDetail: true,
        sequence: 23,
        createdAt: "2026-07-15T03:27:12.686Z",
      }],
      nextSequence: 23,
      hasMore: true,
    });

    expect(response.messages[0].type).toBe("tool_start");
  });

  // Omitted PATCH fields must not acquire create-schema defaults.
  // Rationale: docs/decisions/0032-sdk-contract-regression-history.md.
  it("leaves bags untouched when a session update omits them", () => {
    const parsed = UpdateSessionRequestSchema.parse({ pinned: true });
    expect("bags" in parsed).toBe(false);
    expect(parsed.bags).toBeUndefined();
  });

  it("rejects fields that cannot be applied by a session update", () => {
    expect(UpdateSessionRequestSchema.safeParse({ prompt: "Start a turn" }).success).toBe(false);
    expect(UpdateSessionRequestSchema.safeParse({ useWorktree: true }).success).toBe(false);
  });

  it("lets a session update clear bags explicitly", () => {
    expect(UpdateSessionRequestSchema.parse({ bags: [] }).bags).toEqual([]);
    expect(UpdateSessionRequestSchema.parse({ bags: ["browser"] }).bags).toEqual(["browser"]);
  });

  it("accepts bags and bounds when creating a session", () => {
    expect(CreateSessionRequestSchema.parse({ systemPrompt: "hi" }).bags).toBeUndefined();
    expect(CreateSessionRequestSchema.parse({ systemPrompt: "hi", bags: ["git"], bounds: ["readonly"] })).toMatchObject({
      bags: ["git"],
      bounds: ["readonly"],
    });
  });

  it("validates explicit review policy without accepting unknown modes", () => {
    expect(CreateSessionRequestSchema.parse({ systemPrompt: "hi", reviewPolicy: { mode: "automatic" } }).reviewPolicy).toEqual({ mode: "automatic" });
    expect(CreateSessionRequestSchema.safeParse({ systemPrompt: "hi", reviewPolicy: { mode: "connected-apps" } }).success).toBe(false);
    expect(CreateSessionRequestSchema.safeParse({ systemPrompt: "hi", reviewPolicy: { mode: "review_required", expiresAt: "tomorrow" } }).success).toBe(false);
  });

  it("uses RFC 9457 problem details", () => {
    expect(ProblemDetailsSchema.parse({ title: "Bad request", status: 400 }).type).toBe("about:blank");

  });
});
