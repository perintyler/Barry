import { describe, expect, it } from "vitest";
import {
  changesStatus,
  listChanges,
  getChangesForSession,
  getChangesForFile,
  searchChanges,
  getChangeStats,
  getChange,
  prune,
} from "./tools.js";

/**
 * BAG-24: the tracker records edits from any harness, so its tool descriptions
 * must not name a specific vendor. These strings surface in every agent's tool
 * list.
 */
describe("tracker tool descriptions are vendor-neutral (BAG-24)", () => {
  const tools = [
    changesStatus,
    listChanges,
    getChangesForSession,
    getChangesForFile,
    searchChanges,
    getChangeStats,
    getChange,
    prune,
  ];

  // Brand names that previously leaked into the descriptions / are harness-specific.
  const BRANDS = ["Claude", "ChatGPT", "Codex", "Cursor", "Copilot", "Gemini", "OpenAI", "Anthropic"];

  it.each(tools.map((t) => [t.name, t.description] as const))(
    "%s carries no vendor name",
    (_name, description) => {
      for (const brand of BRANDS) {
        expect(description).not.toContain(brand);
      }
    },
  );

  it("still describes list_changes meaningfully (not just stripped)", () => {
    expect(listChanges.description).toContain("agent");
    expect(getChangesForSession.description.toLowerCase()).toContain("session");
  });
});
