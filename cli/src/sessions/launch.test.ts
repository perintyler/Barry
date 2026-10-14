import { describe, expect, it, vi } from "vitest";
import { discoverConversation } from "./launch.js";

describe("discovering a conversation the harness named itself", () => {
  it("records it once while the TUI runs", async () => {
    const conversation: { id?: string } = {};
    const record = vi.fn(async () => undefined);
    const discovery = discoverConversation(async () => conversation.id, record, 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(record).not.toHaveBeenCalled();
    conversation.id = "thread-1";
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith("thread-1"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    await discovery.stop();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("asks once more when the TUI exits", async () => {
    const conversation: { id?: string } = {};
    const record = vi.fn(async () => undefined);
    const discovery = discoverConversation(async () => conversation.id, record, 60_000);
    conversation.id = "thread-2";
    await discovery.stop();
    expect(record).toHaveBeenCalledWith("thread-2");
  });

  it("records nothing when no conversation was ever started", async () => {
    const record = vi.fn(async () => undefined);
    await discoverConversation(async () => undefined, record, 10).stop();
    expect(record).not.toHaveBeenCalled();
  });

  it("treats a failed lookup as not yet", async () => {
    const record = vi.fn(async () => undefined);
    const discovery = discoverConversation(async () => { throw new Error("unreadable"); }, record, 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await discovery.stop();
    expect(record).not.toHaveBeenCalled();
  });
});
