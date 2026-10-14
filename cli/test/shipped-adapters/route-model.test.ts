/**
 * Which model and vendor `routeModel` routes every session to, pinned.
 *
 * Recorded from the rule that replaced the per-harness catalog, when it was
 * shown to decide every combination the same apart from two intended changes:
 * a `vendor/model` ref is read, and an unreachable model is refused in vendor
 * terms (the adapter model-routing contract, Phase 3). A change here is a routing change.
 */
import { describe, expect, it } from "vitest";
import { shippedVendors } from "../helpers/shipped-vendors.js";

const VENDORS = await shippedVendors();
import type { Adapter } from "@barry-rocks/sdk/adapters/harnesses";
import { routeModel } from "@barry-rocks/sdk/adapters/models";

const ADAPTERS: Record<string, Adapter> = {
  claude: (await import("@barry-rocks/session-claude")).default,
  codex: (await import("@barry-rocks/session-codex")).default,
  cursor: (await import("@barry-rocks/session-cursor")).default,
  opencode: (await import("@barry-rocks/session-opencode")).default,
};

const SESSION_MODELS = [undefined, "claude-opus-5", "gpt-5.5", "claude-opus-5-high", "anthropic/claude-opus-5", "glm-5.2", "qwen3:4b", "my-custom:7b"];
const SESSION_VENDORS = [undefined, "zai", "ollama", "unknown-provider"];
const IDENTITIES: Array<{ label: string; model?: string }> = [
  { label: "none" },
  { label: "(default)+glm-5.2", model: "glm-5.2" },
  { label: "claude+claude-opus-5", model: "claude-opus-5" },
  { label: "claude+glm-5.2", model: "glm-5.2" },
  { label: "claude+qwen3:4b@ollama", model: "ollama/qwen3:4b" },
  { label: "codex+gpt-5.5", model: "gpt-5.5" },
  { label: "opencode+smollm2:135m@ollama", model: "ollama/smollm2:135m" },
];

function decide(harness: string, model: string | undefined, vendor: string | undefined, identity: (typeof IDENTITIES)[number]): string {
  try {
    const route = routeModel(
      ADAPTERS[harness],
      {
        ...(model ? { model } : {}),
        ...(vendor ? { vendor } : {}),
        identity: {
          ...(identity.model ? { model: identity.model } : {}),
        },
      },
      VENDORS,
    );
    return `model=${route.model ?? "-"} vendor=${route.vendor ?? "-"}`;
  } catch (err) {
    return `REFUSED: ${err instanceof Error ? err.message : String(err)}`;
  }
}

describe("routeModel", () => {
  it("routes every recorded combination as recorded", async () => {
    const lines: string[] = [];
    for (const harness of Object.keys(ADAPTERS)) {
      for (const identity of IDENTITIES) {
        for (const model of SESSION_MODELS) {
          for (const vendor of SESSION_VENDORS) {
            lines.push(`${harness} | model=${model ?? "-"} | via=${vendor ?? "-"} | identity=${identity.label} => ${decide(harness, model, vendor, identity)}`);
          }
        }
      }
    }
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("__golden__/route-model.txt");
  });
});
