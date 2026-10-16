import { describe, expect, it, vi } from "vitest";
import { applyBoundGuards } from "./tool-guards.js";
import type { Bound } from "./types.js";
import type { ToolContext } from "../tools/define-tool.js";

describe("guard wrapper context", () => {
  const cases: Array<{ name: string; params: Record<string, unknown>; bound: Bound }> = [
    { name: "Read", params: { file_path: "/allowed.txt" }, bound: { files: { deny: ["/blocked.txt"] } } },
    { name: "WebFetch", params: { url: "https://allowed.example/" }, bound: { network: { deny: ["blocked.example"] } } },
    { name: "Bash", params: { command: "printf hello" }, bound: { network: { deny: ["write"] } } },
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
  const [guarded] = applyBoundGuards([{ name, schema: {}, handler }], { files: { allow: [] } });
  await expect(guarded.handler({ file_path: "/etc/passwd", path: "/etc" }, { secrets: {} })).rejects.toThrow(/Access denied/);
  expect(handler).not.toHaveBeenCalled();
});

describe("bound.inputs parameter guard and JSON Schema narrowing", () => {
  it("allows calls matching inputs.allow and rejects missing or non-matching values", async () => {
    const handler = vi.fn(async () => "sent");
    const bound: Bound = {
      inputs: {
        "slack:send_slack_message": {
          channel: { allow: ["@me"] },
        },
      },
    };
    const [guarded] = applyBoundGuards(
      [{ id: "slack:send_slack_message", namespace: "slack", name: "send_slack_message", handler }],
      bound,
    );

    await expect(guarded.handler({ channel: "@me", text: "hi" }, { secrets: {} })).resolves.toBe("sent");
    await expect(guarded.handler({ channel: "#general", text: "hi" }, { secrets: {} })).rejects.toThrow(
      /Access denied: parameter 'channel'/,
    );
    await expect(guarded.handler({ text: "hi" }, { secrets: {} })).rejects.toThrow(
      /Access denied: parameter 'channel' is required/,
    );
  });

  it("enforces inputs.deny globs while permitting omitted optional parameters", async () => {
    const handler = vi.fn(async () => "pushed");
    const bound: Bound = {
      inputs: {
        "git:push": {
          branch: { deny: ["main", "master", "release/*"] },
        },
      },
    };
    const [guarded] = applyBoundGuards(
      [{ id: "git:push", namespace: "git", name: "push", handler }],
      bound,
    );

    await expect(guarded.handler({ branch: "feat/no-traits" }, { secrets: {} })).resolves.toBe("pushed");
    await expect(guarded.handler({}, { secrets: {} })).resolves.toBe("pushed");
    await expect(guarded.handler({ branch: "main" }, { secrets: {} })).rejects.toThrow(
      /Access denied: parameter 'branch' on 'git:push' matches deny pattern 'main'/,
    );
    await expect(guarded.handler({ branch: "release/v1" }, { secrets: {} })).rejects.toThrow(
      /Access denied: parameter 'branch' on 'git:push' matches deny pattern 'release\/\*'/,
    );
  });
});

describe("built-in Barry config file write protection", () => {
  it("blocks writing to ~/.barry/identities/** and **/bag.yaml unless explicitly allowed in files.allow", async () => {
    const handler = vi.fn(async () => "written");
    const [writeTool] = applyBoundGuards(
      [{ name: "Write", handler }],
      {},
      { enforceConfigProtection: true },
    );
    await expect(
      writeTool.handler({ file_path: "~/.barry/identities/me/identity.yaml" }, { secrets: {} }),
    ).rejects.toThrow(/Access denied: writing to Barry configuration path/);
    await expect(
      writeTool.handler({ file_path: "/Users/tyler/repos/barry/bags/slack/bag.yaml" }, { secrets: {} }),
    ).rejects.toThrow(/Access denied: writing to Barry configuration path/);
    await expect(
      writeTool.handler({ file_path: "/Users/tyler/repos/barry/src/index.ts" }, { secrets: {} }),
    ).resolves.toBe("written");
  });
});

