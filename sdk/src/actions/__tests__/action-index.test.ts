import { describe, it, expect } from "vitest";
import { buildActionsIndex } from "../action-index.js";
import type { ActionMeta } from "../action-registry.js";

function action(name: string, description = "Does a thing", shadowed = false): ActionMeta {
  return {
    source: "bag",
    name,
    bag: "ops",
    qualifiedName: `ops:${name}`,
    dir: `/bags/ops/actions/${name}`,
    description,
    prompt: "body",
    requires: { tools: [], secrets: [], bins: [] },
    instructions: [],
    steps: [],
    slashCommand: false,
    scripts: [],
    context: "session",
    legacySkill: false,
    bagAccess: "enabled",
    shadowed,
  };
}

describe("buildActionsIndex", () => {
  it("tells the agent to call begin_action, the tool that exists", () => {
    // It said use_action for months after the rename, so every session was
    // told to call a tool no bag defines.
    const index = buildActionsIndex([action("deploy")]) ?? "";
    expect(index).toContain("`begin_action`");
    expect(index).not.toContain("use_action");
  });

  it("returns null when there is nothing to list", () => {
    expect(buildActionsIndex([])).toBeNull();
  });

  it("lists each action by name and description", () => {
    const index = buildActionsIndex([action("deploy", "Ship it"), action("rollback", "Undo it")]);
    expect(index).toContain("- deploy: Ship it");
    expect(index).toContain("- rollback: Undo it");
  });

  it("omits shadowed actions — a bare name would resolve elsewhere", () => {
    const index = buildActionsIndex([action("deploy"), action("deploy", "dupe", true)]);
    expect(index?.match(/- deploy:/g)).toHaveLength(1);
  });

  it("returns null when every action is shadowed", () => {
    expect(buildActionsIndex([action("deploy", "d", true)])).toBeNull();
  });

  it("drops whole entries from the tail and says how many, rather than truncating each", () => {
    const many = Array.from({ length: 50 }, (_, i) => action(`action-${i}`, "x".repeat(60)));
    const index = buildActionsIndex(many, { budgetChars: 600 });

    expect(index).toContain("…and");
    expect(index).toContain("more; call find_actions");
    // Surviving entries keep their full description — no per-line ellipsizing.
    expect(index).toContain("x".repeat(60));
    expect(index!.length).toBeLessThan(900);
  });

  it("returns null rather than a header with no entries when the budget is tiny", () => {
    expect(buildActionsIndex([action("deploy", "x".repeat(500))], { budgetChars: 50 })).toBeNull();
  });

  it("does not add a tail note when everything fits", () => {
    const index = buildActionsIndex([action("deploy")], { budgetChars: 4000 });
    expect(index).not.toContain("…and");
  });
});
