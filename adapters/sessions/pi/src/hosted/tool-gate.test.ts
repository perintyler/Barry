import { expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiToolGate } from "./tool-gate.js";

it("passes granted natives to decide and blocks caller denials and ungranted tools", async () => {
  const decide = vi.fn(async () => ({ allow: true }));
  const on = vi.fn();
  const api = {} as ExtensionAPI;
  api.on = on;
  await createPiToolGate({ sessionId: "native", cwd: "/scratch", env: {}, mcpServers: {},
    allowedNativeTools: ["read", "grep"], deniedTools: ["grep"], decide,
  })(api);
  const handler = on.mock.calls[0][1] as (event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) => Promise<{ block: boolean; reason: string } | undefined>;
  const event = (toolName: string) => ({ toolName, toolCallId: "call", input: {} });
  expect(await handler(event("read"))).toBeUndefined();
  expect(decide).toHaveBeenCalledWith({ id: "call", tool: "read", input: {} });
  expect(await handler(event("grep"))).toMatchObject({ block: true });
  expect(await handler(event("bash"))).toMatchObject({ block: true });
  expect(decide).toHaveBeenCalledTimes(1);
});
