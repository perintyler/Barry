import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { shippedVendors } from "../../test/helpers/shipped-vendors.js";

const VENDORS = await shippedVendors();
import type { InstalledAdapter, Adapter } from "@barry-rocks/sdk/adapters/harnesses";
import { harnessAdapter, resetAdapterStore } from "../adapters/installed.js";
import { selectHarness, selectMode, resolveModelSelection, type StartOptions } from "./start.js";

// The shipped adapters, loaded the way `barry start` loads them — from a
// store in a BARRY_HOME that is never the developer's own.
const savedHome = process.env.BARRY_HOME;
const home = mkdtempSync(join(tmpdir(), "barry-launch-provider-"));
const harnesses: Record<string, Adapter> = {};
let records: InstalledAdapter[];
beforeAll(async () => {
  process.env.BARRY_HOME = home;
  process.env.BARRY_CONFIG_ALLOW_EMPTY = "1";
  resetAdapterStore();
  const { adapterStore } = await import("../adapters/installed.js");
  const { adapters } = await adapterStore();
  for (const id of ["claude", "codex"]) {
    const { fileURLToPath } = await import("node:url");
    await adapters.add(fileURLToPath(new URL(`../../../adapters/sessions/${id}/`, import.meta.url)));
    harnesses[id] = await harnessAdapter(id);
  }
  records = adapters.installed();
});
afterAll(() => {
  delete process.env.BARRY_CONFIG_ALLOW_EMPTY;
  if (savedHome === undefined) delete process.env.BARRY_HOME;
  else process.env.BARRY_HOME = savedHome;
  resetAdapterStore();
  rmSync(home, { recursive: true, force: true });
});

function select(options: StartOptions, harness: string, identity?: Parameters<typeof resolveModelSelection>[2]) {
  return resolveModelSelection(options, harnesses[harness], identity, VENDORS);
}

describe("selectHarness", () => {
  it("defaults to the installed fallback", () => {
    expect(selectHarness({}, {}, records).id).toBe("claude-code");
  });
  it("applies explicit, vendor, identity and fallback precedence", () => {
    const identity = { codex: { default: true }, "claude-code": {} };
    expect(selectHarness({}, identity, records).id).toBe("codex");
    expect(selectHarness({ harness: "claude" }, identity, records).id).toBe("claude-code");
    expect(selectHarness({ ollama: true }, identity, records).id).toBe("claude-code");
    expect(selectHarness({ modelProvider: "ollama" }, identity, records).id).toBe("claude-code");
    expect(selectHarness({ harness: "codex", ollama: true }, identity, records).id).toBe("codex");
    expect(() => selectHarness({}, { codex: {}, "claude-code": {} }, records)).toThrow("--default");
    expect(selectHarness({ harness: "codex" }, { codex: {}, "claude-code": {} }, records).id).toBe("codex");
    expect(() => selectHarness({ harness: "missing" }, {}, records)).toThrow("not an installed adapter");
  });
  it("selects every installed id and alias through its record", () => {
    for (const record of records) for (const id of [record.id, ...(record.aliases ?? [])]) expect(selectHarness({ harness: id }, {}, records)).toBe(record);
  });
  it("keeps an identity-selected codex record through mode selection", () => {
    const identity = { name: "coder", adapters: { codex: { default: true, mode: "guest" as const } } };
    const record = selectHarness({}, identity.adapters, records);
    expect(record.id).toBe("codex");
    expect(selectMode({}, identity, record).mode).toBe("guest");
    expect(selectMode({ mode: "hosted" }, identity, record).mode).toBe("hosted");
  });
  it("names the identity when its mode is not declared", () => {
    const record = { ...records.find(record => record.id === "codex")!, modes: { hosted: null, instrumented: null, guest: null } };
    expect(() => selectMode({}, { name: "coder", adapters: { codex: { mode: "guest" } } }, record)).toThrow("identity coder sets adapters.codex.mode: guest");
  });
});

// `--zai`/`--ollama`/`--model-provider` name a MODEL PROVIDER. What they must
// guarantee: the route follows the flag even for a model no catalog knows, an
// explicit -m is never discarded, and an identity's own choice survives.
describe("resolveModelSelection", () => {
  it("resolves --zai to z.ai's default model", () => {
    expect(select({ zai: true }, "claude")).toEqual({ model: "glm-5.2", modelProvider: "zai" });
  });

  it("resolves --ollama to Ollama's default model", () => {
    expect(select({ ollama: true }, "claude")).toEqual({ model: "qwen3:4b", modelProvider: "ollama" });
  });

  it("resolves --llamacpp to llama.cpp's default model", () => {
    expect(select({ llamacpp: true }, "claude")).toEqual({ model: "default", modelProvider: "llamacpp" });
  });

  it("selects nothing when no flag and no identity default is set", () => {
    expect(select({}, "claude")).toEqual({ model: undefined, modelProvider: undefined });
  });

  // An explicit -m always wins. Without this, --zai -m glm-4.5 would silently
  // discard the model the user actually typed.
  it("keeps an explicit --model alongside a provider flag", () => {
    expect(select({ zai: true, model: "glm-4.5" }, "claude")).toEqual({ model: "glm-4.5", modelProvider: "zai" });
  });

  // The first-class case: the custom id is in no catalog, so only the flag
  // can route it. Before, it silently went to Anthropic.
  it("routes a custom -m to Ollama under --ollama", () => {
    expect(select({ ollama: true, model: "my-custom:7b" }, "claude"))
      .toEqual({ model: "my-custom:7b", modelProvider: "ollama" });
  });

  it("treats --model-provider ollama like --ollama", () => {
    expect(select({ modelProvider: "ollama", model: "my-custom:7b" }, "claude"))
      .toEqual({ model: "my-custom:7b", modelProvider: "ollama" });
  });

  it("refuses conflicting provider flags", () => {
    expect(() => select({ zai: true, ollama: true }, "claude")).toThrow(/Conflicting/);
    expect(() => select({ modelProvider: "zai", ollama: true }, "claude")).toThrow(/Conflicting/);
  });

  it("accepts the same provider named twice", () => {
    expect(select({ modelProvider: "ollama", ollama: true }, "claude").modelProvider).toBe("ollama");
  });

  it("uses the identity's default provider and model when no flag is given", () => {
    expect(select({}, "claude", "ollama/my-custom:7b"))
      .toEqual({ model: "my-custom:7b", modelProvider: "ollama" });
  });

  it("refuses an unreachable provider on an agent that cannot reach it", () => {
    expect(() => select({ zai: true, harness: "codex" }, "codex")).toThrow(/codex/);
  });
});
