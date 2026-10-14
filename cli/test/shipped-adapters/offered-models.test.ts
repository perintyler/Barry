/**
 * The models each harness offers, and what it suggests for a partial or
 * misspelled id, pinned.
 *
 * Recorded when they were shown equal to models.yaml's per-harness lists,
 * which they replaced (the adapter model-routing contract, Phase 3).
 */
import { describe, expect, it } from "vitest";
import { shippedVendors } from "../helpers/shipped-vendors.js";

const VENDORS = await shippedVendors();
import type { Adapter } from "@barry-rocks/sdk/adapters/harnesses";
import { offeredModels, suggestOfferedModels } from "@barry-rocks/sdk/adapters/models";

const ADAPTERS: Record<string, Adapter> = {
  claude: (await import("@barry-rocks/session-claude")).default,
  codex: (await import("@barry-rocks/session-codex")).default,
  cursor: (await import("@barry-rocks/session-cursor")).default,
  opencode: (await import("@barry-rocks/session-opencode")).default,
};

const PARTIALS = ["opus", "claude-huiku", "gpt-5", "glm", "qwen", "sonet", "codex", "composer", "xyz", "anthropic/"];

describe("the models each harness offers", () => {
  it("are the ones recorded, with the suggestions recorded", async () => {
    const offered = Object.fromEntries(
      Object.entries(ADAPTERS).map(([harness, adapter]) => [
        harness,
        {
          offered: offeredModels(adapter, VENDORS),
          suggestions: Object.fromEntries(PARTIALS.map((partial) => [partial, suggestOfferedModels(adapter, VENDORS, partial)])),
        },
      ]),
    );
    await expect(JSON.stringify(offered, null, 2) + "\n").toMatchFileSnapshot("__golden__/offered-models.json");
  });
});
