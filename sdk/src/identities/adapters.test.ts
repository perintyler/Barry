import { describe, expect, it } from "vitest";
import { adapterSettings, defaultHarness, IdentityAdaptersSchema, mergeAdapters, ownAdapters, type IdentityAdapters } from "./adapters.js";

describe("identity adapters", () => {
  it.each([
    { claude: { default: true }, codex: { default: true } },
    { codex: { modle: "gpt-5" } },
    { codex: { mode: "attached" } },
    { "Invalid!": {} },
  ])("refuses malformed settings %j", adapters => {
    expect(IdentityAdaptersSchema.safeParse(adapters).success).toBe(false);
  });

  it("selects explicit, implicit and absent defaults, refusing ambiguity", () => {
    expect(defaultHarness({ claude: {}, codex: { default: true } })).toBe("codex");
    expect(defaultHarness({ codex: {} })).toBe("codex");
    expect(defaultHarness({})).toBeUndefined();
    expect(() => defaultHarness({ claude: {}, codex: {} })).toThrow("barry identity adapters set <harness> --default");
  });

  it("finds aliases after the current id", () => {
    const record = { id: "claude-code", aliases: ["claude"] };
    expect(adapterSettings({ claude: { model: "old" } }, record)?.model).toBe("old");
    expect(adapterSettings({ claude: { model: "old" }, "claude-code": { model: "new" } }, record)?.model).toBe("new");
  });

  it("merges fields and carries the implicit parent default", () => {
    expect(mergeAdapters({ claude: { model: "opus", mode: "guest" } }, { claude: { model: "sonnet" }, codex: {} })).toEqual({ claude: { default: true, model: "sonnet", mode: "guest" }, codex: {} });
    expect(mergeAdapters({ claude: { default: true } }, { codex: { default: true } })).toEqual({ claude: {}, codex: { default: true } });
    expect(mergeAdapters({}, { codex: { default: false } })).toEqual({ codex: {} });
  });

  const cases: [IdentityAdapters, IdentityAdapters, IdentityAdapters][] = [
    [{ claude: { default: true, model: "opus" } }, { claude: { default: true, model: "opus" } }, {}],
    [{ claude: { default: true, model: "opus" } }, { claude: { default: true, model: "sonnet" }, codex: {} }, { claude: { model: "sonnet" }, codex: {} }],
    [{ claude: { default: true } }, { claude: {}, codex: { default: true, mode: "guest" } }, { codex: { default: true, mode: "guest" } }],
    [{ claude: {}, codex: {} }, { claude: {}, codex: { default: true } }, { codex: { default: true } }],
    [{ claude: { model: "opus" } }, { claude: { default: true, model: "opus" }, codex: {} }, { codex: {} }],
  ];
  it.each(cases)("writes only the child's overrides", (parent, intended, own) => {
    expect(ownAdapters(parent, intended)).toEqual(own);
    expect(mergeAdapters(parent, own)).toEqual(mergeAdapters(parent, intended));
  });
});
