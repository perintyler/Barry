import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { CliError } from "./../lib/cli-error.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { Barry, type IdentityCreate } from "@barry-rocks/sdk";
import { identities } from "@barry-rocks/identities-bag";
import { shippedVendors } from "../../test/helpers/shipped-vendors.js";
import { createIdentity, provisionOwner } from "../../test/helpers/identities.js";

const VENDORS = await shippedVendors();
import { createModels, installModels } from "@barry-rocks/sdk/adapters/models";
import claudeCode from "@barry-rocks/session-claude";
import opencode from "@barry-rocks/session-opencode";
import type { Adapter, InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";

/** The record the loader would keep for a shipped adapter: its own declarations. */
function recordOf(adapter: Adapter): InstalledAdapter {
  return {
    packageName: `@fixture/${adapter.id}`,
    contractVersion: 1,
    id: adapter.id,
    ...(adapter.aliases?.length ? { aliases: [...adapter.aliases] } : {}),
    label: adapter.label,
    ...(adapter.vendor ? { vendor: adapter.vendor } : {}),
    ...(adapter.offeredModels ? { offeredModels: adapter.offeredModels.map((model) => ({ ...model })) } : {}),
    requirements: adapter.requirements,
    capabilities: adapter.capabilities,
    tools: [...adapter.tools],
    defaultMode: adapter.defaultMode,
    modes: { hosted: null, instrumented: null, guest: null },
    path: `/adapters/${adapter.id}`,
    version: "0.0.0-test",
    installedAt: "2026-09-29T00:00:00.000Z",
  };
}

// The real adapters' own declarations, so what the writers do with a harness's
// vendor and aliases is what they would do on this machine.
vi.mock("../adapters/installed.js", () => ({
  adapterStore: async () => ({
    adapters: { installed: () => [recordOf(claudeCode), recordOf(opencode)], add: vi.fn(), load: vi.fn() },
  }),
}));

let counter = 0;

/**
 * A directory identity made as `barry identity create` makes one, in this
 * file's scratch home. `legacy` keys go straight into its identity.yaml, as an
 * older Barry wrote them: no change spells them any more.
 */
async function seedIdentity(fields: Omit<IdentityCreate, "name"> = {}, legacy: Record<string, unknown> = {}): Promise<{ name: string; dir: string }> {
  const created = await createIdentity({ name: `adapter-${++counter}`, ...fields });
  const dir = created.dir!;
  if (Object.keys(legacy).length > 0) writeFileSync(join(dir, "identity.yaml"), yamlStringify({ ...readYaml(dir), ...legacy }));
  return { name: created.record.name, dir };
}

function readYaml(dir: string): Record<string, unknown> {
  return yamlParse(readFileSync(join(dir, "identity.yaml"), "utf-8")) as Record<string, unknown>;
}

// The vendor model list, as the CLI's entry point installs it: what says which
// vendor serves a model.
installModels(createModels(VENDORS));

beforeAll(() => {
  Barry.use(identities);
  provisionOwner();
  // A registry naming none of the base identity's bags, so creating an
  // identity does not load and build every one of them for their bounds.
  writeFileSync(
    join(process.env.BARRY_HOME!, "app-support", "bags.snapshot.json"),
    JSON.stringify({ bags: { "zz-unused": { type: "remote", url: "https://example.test/mcp" } } }),
  );
});
afterAll(() => Barry.reset());

describe("barry identity adapters", () => {
  it("writes the canonical id and clears retired keys", async () => {
    const { name, dir } = await seedIdentity({}, { default_coding_agent: "claude" });
    const { setIdentityAdapterCommand } = await import("./identity.js");
    await setIdentityAdapterCommand("claude", { name, model: "claude-opus-5" });
    expect(readYaml(dir).adapters).toEqual({ "claude-code": { model: "anthropic/claude-opus-5" } });
    expect(readYaml(dir).default_coding_agent).toBeUndefined();
  });
  it.each([false, true])("stores a vendor/model ref with provider flag %s", async providerFlag => {
    const { name, dir } = await seedIdentity();
    const { setIdentityAdapterCommand } = await import("./identity.js");
    await setIdentityAdapterCommand("claude", { name, model: providerFlag ? "qwen3:4b" : "ollama/qwen3:4b", ...(providerFlag ? { provider: "ollama" } : {}) });
    expect(readYaml(dir).adapters).toEqual({ "claude-code": { model: "ollama/qwen3:4b" } });
  });
  it("chooses a new default explicitly", async () => {
    const { name, dir } = await seedIdentity();
    const { setIdentityAdapterCommand } = await import("./identity.js");
    await setIdentityAdapterCommand("opencode", { name, default: true });
    expect(readYaml(dir).adapters).toEqual({ opencode: { default: true } });
  });
  it("keeps fallback as default on an empty identity", async () => {
    const { name, dir } = await seedIdentity();
    writeFileSync(join(dir, "identity.yaml"), yamlStringify({ name }));
    const { setIdentityAdapterCommand } = await import("./identity.js");
    await setIdentityAdapterCommand("opencode", { name, model: "custom" });
    expect(readYaml(dir).adapters).toEqual({ "claude-code": { default: true }, opencode: { model: "custom" } });
  });
  it("refuses an undeclared mode without writing", async () => {
    const { name, dir } = await seedIdentity();
    const before = readFileSync(join(dir, "identity.yaml"), "utf8");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { setIdentityAdapterCommand } = await import("./identity.js");
    await expect(setIdentityAdapterCommand("claude", { name, mode: "guest" })).rejects.toThrow(/guest/);
    expect(readFileSync(join(dir, "identity.yaml"), "utf8")).toBe(before);
    exit.mockRestore(); error.mockRestore();
  });
  it("refuses inherited entries and a default with other entries", async () => {
    const { name, dir } = await seedIdentity();
    const { removeIdentityAdapterCommand } = await import("./identity.js");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(removeIdentityAdapterCommand("claude", { name })).rejects.toThrow(/inherited from base/);
    writeFileSync(join(dir, "identity.yaml"), yamlStringify({ name, adapters: { "claude-code": { default: true }, opencode: {} } }));
    await expect(removeIdentityAdapterCommand("claude", { name })).rejects.toThrow(/Set another default first/);
    await removeIdentityAdapterCommand("opencode", { name });
    expect(readYaml(dir).adapters).toEqual({ "claude-code": { default: true } });
    exit.mockRestore(); error.mockRestore();
  });
});
