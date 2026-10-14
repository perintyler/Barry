import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `endSession` deletes a session that produced no messages, and closes every
 * other. "No messages" is Barry's count: a guest TUI's conversation belongs to
 * the harness and Barry records none of it, so a session with a linked
 * harness conversation must be closed — deleting it lost `barry resume`'s
 * only way back to that conversation.
 */

const getSession = vi.fn();
const getSessionMessageCount = vi.fn();
const getProviderSessionsBySession = vi.fn();
const endStoredSession = vi.fn();
const deleteSession = vi.fn();

vi.mock("@barry-rocks/sessions-bag/client", () => ({
  getSession: (...a: unknown[]) => getSession(...a),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  endSession: (...a: unknown[]) => endStoredSession(...a),
  deleteSession: (...a: unknown[]) => deleteSession(...a),
  deleteSessionsByIdentity: vi.fn(),
  getSessionMessageCount: (...a: unknown[]) => getSessionMessageCount(...a),
  getProviderSessionsBySession: (...a: unknown[]) => getProviderSessionsBySession(...a),
  createProviderSession: vi.fn(),
}));


const { endSession } = await import("./index.js");

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ id: "sess-1", system_prompt: null });
  getSessionMessageCount.mockResolvedValue(0);
  getProviderSessionsBySession.mockResolvedValue([]);
});

describe("endSession", () => {
  it("deletes a session that never started anything — a launch cancelled at its picker", async () => {
    await endSession({ session_id: "sess-1", reason: "process_exit" });

    expect(deleteSession).toHaveBeenCalledWith("sess-1");
    expect(endStoredSession).not.toHaveBeenCalled();
  });

  it("closes a session whose harness conversation Barry did not capture, so it can be resumed", async () => {
    getProviderSessionsBySession.mockResolvedValue([{ provider: "opencode", provider_session_id: "ses_abc" }]);

    await endSession({ session_id: "sess-1", reason: "process_exit" });

    expect(deleteSession).not.toHaveBeenCalled();
    expect(endStoredSession).toHaveBeenCalledWith("sess-1", "process_exit");
  });

  it("closes a session carrying a directive", async () => {
    getSession.mockResolvedValue({ id: "sess-1", system_prompt: "fix the build" });

    await endSession({ session_id: "sess-1", reason: "process_exit" });

    expect(deleteSession).not.toHaveBeenCalled();
    expect(endStoredSession).toHaveBeenCalled();
  });

  it("closes a session that has messages", async () => {
    getSessionMessageCount.mockResolvedValue(3);

    await endSession({ session_id: "sess-1", reason: "process_exit" });

    expect(deleteSession).not.toHaveBeenCalled();
    expect(endStoredSession).toHaveBeenCalled();
  });
});
