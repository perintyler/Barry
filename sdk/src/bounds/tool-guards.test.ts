import { describe, expect, it, vi } from "vitest";
import { applyBoundGuards } from "./tool-guards.js";
import type { Bound } from "./types.js";
import type { ToolContext } from "../tools/define-tool.js";

describe("guard wrapper context", () => {
  const cases: Array<{ name: string; params: Record<string, unknown>; bound: Bound }> = [
    { name: "Read", params: { file_path: "/allowed.txt" }, bound: { files: { deny: ["/blocked.txt"] } } },
    { name: "WebFetch", params: { url: "https://allowed.example/" }, bound: { network: { domains: ["blocked.example"] } } },
    { name: "Bash", params: { command: "printf hello" }, bound: { network: { actions: ["write"] } } },
  ];
  for (const { name, params, bound } of cases) {
    it(`preserves the identical ToolContext through ${name}`, async () => {
      const context: ToolContext = { secrets: { TOKEN: "synthetic" }, sessionId: "session", availableTools: ["example:tool"] };
      const handler = vi.fn(async (_params: Record<string, unknown>, _context: ToolContext) => "result");
      const [guarded] = applyBoundGuards([{ name, handler }], bound);
      expect(await guarded.handler(params, context)).toBe("result");
      expect(handler).toHaveBeenCalledExactlyOnceWith(params, context);
    });
  }
});


it.each(["Read", "Grep"])("keeps %s native paths guarded when an empty schema is supplied", async name => {
  const handler = vi.fn(async () => "must not run");
  const [guarded] = applyBoundGuards([{ name, schema: {}, handler }], { files: { allowOnly: [] } });
  await expect(guarded.handler({ file_path: "/etc/passwd", path: "/etc" }, { secrets: {} })).rejects.toThrow(/Access denied/);
  expect(handler).not.toHaveBeenCalled();
});
