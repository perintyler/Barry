import { expect, it, vi } from "vitest";
import { startClaudeLive } from "./start.js";
import { CLAUDE_LIVE } from "../modes.js";
const { query, opened } = vi.hoisted(() => {
  let notify: () => void;
  const opened = new Promise<void>(resolve => { notify = resolve; });
  const query = vi.fn((..._args: unknown[]) => {
    notify();
    return { async *[Symbol.asyncIterator]() {}, close() {}, async interrupt() {} };
  });
  return { query, opened };
});
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query }));
it("opens with the shared hook and its timeout, without canUseTool", async () => {
  const session = startClaudeLive({ sessionId: "test", cwd: "/tmp", env: {}, mcpServers: {} }, { guarantees: CLAUDE_LIVE.guarantees, rulingWindow: 3 });
  await session.deliver("hello");
  await opened;
  expect(query).toHaveBeenCalled();
  const options = query.mock.calls[0][0] as { options: Record<string, unknown> };
  expect(options.options).not.toHaveProperty("canUseTool");
  expect(options.options.hooks).toMatchObject({ PreToolUse: [{ timeout: 3, hooks: [expect.any(Function)] }] });
  await session.close();
});
