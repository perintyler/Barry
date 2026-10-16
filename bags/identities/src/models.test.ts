import { afterEach, describe, expect, it } from "vitest";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { defineVendor } from "@barry-rocks/sdk/adapters/models";
import { prepareChanges } from "./operations/identity-records.js";
import { isKnownModelFor, knownHarness, setIdentityModels } from "./models.js";

const VENDORS = [
  defineVendor({ id: "anthropic", label: "Anthropic", credential: null, models: [{ id: "claude-opus-5", label: "Opus 5", kind: "completion" }] }),
  defineVendor({
    id: "zai",
    label: "z.ai",
    compatible: [{ with: "anthropic", baseUrl: "https://z.example" }],
    credential: { env: "Z_AI_API_KEY" },
    models: [{ id: "glm-5.2", label: "GLM-5.2", kind: "completion" }],
  }),
];

const CLAUDE: InstalledAdapter = {
  packageName: "@fixture/claude",
  contractVersion: 1,
  id: "claude",
  label: "Claude Code",
  vendor: "anthropic",
  requirements: { binary: { command: "claude", versionArgs: [], versionPattern: "", install: {}, pin: { version: "0", enforcedBy: "test" } } },
  capabilities: {
    mcpTransports: ["stdio"],
    toolDenial: "native",
    systemPromptFormat: "preset-append",
    skillsMount: "plugin",
    withoutKey: "subscription-oauth",
    endpoint: "configurable",
  },
  tools: [],
  defaultMode: "guest",
  modes: { hosted: null, instrumented: null, guest: null },
  path: "/adapters/sessions/claude",
  version: "0.0.0",
  installedAt: "2026-09-29T00:00:00.000Z",
};

function wire(): void {
  setIdentityModels({ vendors: () => VENDORS, harnesses: () => [CLAUDE] });
}

afterEach(() => {
  setIdentityModels({ vendors: () => [], harnesses: () => [] });
});

describe("isKnownModelFor", () => {
  it("knows a harness's own models and the ones it can be routed to", () => {
    wire();
    expect(isKnownModelFor("claude", "claude-opus-5")).toBe(true);
    expect(isKnownModelFor("claude", "glm-5.2")).toBe(true);
  });

  it("does not know a model the harness does not offer", () => {
    wire();
    expect(isKnownModelFor("claude", "claude-opus-9")).toBe(false);
  });

  it("says nothing about a harness it has no record of", () => {
    wire();
    expect(isKnownModelFor("some-other-harness", "anything")).toBe(true);
  });
});

describe("knownHarness", () => {
  it("returns the installed record and refuses unknown membership", () => {
    wire();
    expect(knownHarness("claude")).toEqual(CLAUDE);
    expect(knownHarness("nope")).toBeUndefined();
  });
});

describe("adapter change warnings", () => {
  it("warns about unknown harnesses, models and undeclared modes", async () => {
    setIdentityModels({ vendors: () => VENDORS, harnesses: () => [CLAUDE] });
    const result = await prepareChanges({ adapters: { claude: { default: true, model: "nope", mode: "guest" }, unknown: {} } }, {});
    expect(result.warnings.map(warning => warning.kind)).toEqual(["unknown-model", "unknown-mode", "unknown-harness"]);
  });
  it("rejects two keys naming the same installed harness", async () => {
    setIdentityModels({ vendors: () => VENDORS, harnesses: () => [{ ...CLAUDE, aliases: ["claude-code"] }] });
    await expect(prepareChanges({ adapters: { claude: { default: true }, "claude-code": {} } }, {})).rejects.toMatchObject({ reason: "invalid", message: expect.stringContaining("same harness") });
  });
});
