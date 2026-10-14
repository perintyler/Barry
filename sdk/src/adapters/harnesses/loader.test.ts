import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAdapters } from "./loader.js";
import { AdapterRefused } from "./index.js";
import type { VendorCode } from "../models/vendors/catalog.js";
import { assembleVendors } from "../models/vendors/catalog.js";
import { createModels } from "../models/create.js";
import type { Question } from "../decisions/index.js";

/** A minimal adapter that passes checkAdapter: one guest launch mode, nothing claimed twice. */
function adapterLiteral(id: string): Record<string, unknown> {
  return {
    id,
    label: `Fixture ${id}`,
    requirements: {
      binary: {
        command: "fixture-bin",
        versionArgs: ["--version"],
        versionPattern: "(\\d+\\.\\d+\\.\\d+)",
        install: { darwin: "brew install fixture-bin" },
        pin: { version: "0.0.0", enforcedBy: "the fixture never changes" },
      },
    },
    capabilities: {
      mcpTransports: ["stdio"],
      toolDenial: "none",
      systemPromptFormat: "unsupported",
      skillsMount: "none",
      withoutKey: "unauthenticated",
      endpoint: "fixed",
    },
    nativeTools: [],
    defaultMode: "guest",
    modes: {
      hosted: null,
      instrumented: null,
      guest: {
        guarantees: { capture: "none", delivery: "none", steer: false, interrupt: false, gating: "none", keepsVendorUi: true, identity: "none" },
        verifiedOn: "0.0.0",
        evidence: { check: "no check", proves: "a fixture claims nothing" },
        egressSandbox: false,
        native: { grantable: [], uncontrolled: {}, inseparable: [], operatorOverride: "fixture override" },
        plan: async () => ({ command: "fixture-bin", args: [] }),
      },
    },
  };
}

function vendorCodeLiteral(): VendorCode {
  return {
    vendors: [
      {
        id: "acme",
        label: "Acme",
        baseUrl: "https://acme.test/v1",
        credential: { env: "ACME_API_KEY" },
        models: [{ id: "judge", label: "Judge", kind: "decision", roles: ["default"] }],
      },
    ],
    factories: {
      decision: {
        acme: (model) => ({
          ref: `acme/${model}`,
          async decide(request: { questions: Record<string, Question> }) {
            return {
              answers: Object.fromEntries(
                Object.keys(request.questions).map((name) => [name, { type: "boolean" as const, value: true, probability: 0.75 }]),
              ),
              servedModel: "judge-1.0",
            };
          },
        }),
      },
    },
  };
}

let home: string;

it("refuses a declared bag outside the adapter package before loading its manifest", async () => {
  const directory = join(home, "escaping"); mkdirSync(directory);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "escaping", version: "1.0.0", type: "module", exports: "./adapter.js", barry: { sessionAdapter: { contractVersion: 1 } } }));
  writeFileSync(join(directory, "adapter.js"), "export default {};\n");
  const store = loadAdapters({ file: join(home, "adapters.json"), importModule: async () => ({ default: { ...adapterLiteral("escaping"), bag: "../outside" } }) });
  await expect(store.add(directory)).rejects.toThrow("adapter bag must stay within its package");
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "barry-vendor-code-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A package on disk (package.json only — the module arrives by injection), recorded by a store over it. */
function storeFor(id: string, options: { vendorCode?: VendorCode; importModule?: (entry: string) => Promise<unknown> } = {}) {
  const dir = join(home, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `@fixture/${id}`, version: "1.0.0", type: "module", exports: "./adapter.js", barry: { sessionAdapter: { contractVersion: 1 } } }),
  );
  writeFileSync(join(dir, "adapter.js"), "export default {};\n");
  return loadAdapters({
    file: join(home, "adapters.json"),
    importModule:
      options.importModule ??
      (async () => ({ default: adapterLiteral(id), ...(options.vendorCode ? { vendorCode: options.vendorCode } : {}) })),
  });
}

describe("an installed adapter carrying vendor code", () => {
  it("registers and snapshots an explicitly declared policy bag without packing it", async () => {
    const dir = join(home, "policy");
    storeFor("policy");
    writeFileSync(join(dir, "bag.yaml"), "name: policy\ndescription: Policy only\nbounds:\n  no-shell:\n    description: No shell\n    bound:\n      nativeTools:\n        policy: [shell]\ntraits:\n  native-shell:\n    description: Native shell\n    nativeTools:\n      policy: [shell]\n");
    const registerBag = vi.fn(async () => undefined);
    const importModule = vi.fn(async () => ({ default: { ...adapterLiteral("policy"), bag: ".", nativeTools: ["shell"] } }));
    const store = loadAdapters({ file: join(home, "adapters.json"), importModule, registerBag });
    const record = await store.add(dir);
    expect(registerBag).toHaveBeenCalledWith("policy", dir, record.bag?.manifest);
    importModule.mockClear();
    expect(store.installed()[0]?.bag?.manifest.traits["policy:native-shell"]?.nativeTools).toEqual({ policy: ["shell"] });
    expect(store.installed()[0]?.modes.guest?.native).toEqual({ grantable: [], uncontrolled: {}, inseparable: [], operatorOverride: "fixture override" });
    expect(importModule).not.toHaveBeenCalled();
    writeFileSync(join(dir, "bag.yaml"), "name: policy\ndescription: Broken policy\nbounds:\n  bad:\n    description: Typo\n    bound:\n      nativeTools:\n        policy: [typo]\n");
    await expect(store.load("policy")).rejects.toThrow(/no native tools/);
    expect(store.installed()[0]?.bag?.manifest.description).toBe("Policy only");
  });

  it("does not record an adapter when ordinary bag registration refuses its name", async () => {
    const dir = join(home, "policy");
    storeFor("policy");
    writeFileSync(join(dir, "bag.yaml"), "name: policy\ndescription: Policy only\n");
    const store = loadAdapters({ file: join(home, "adapters.json"), importModule: async () => ({ default: { ...adapterLiteral("policy"), bag: "." } }), registerBag: async () => { throw new Error("bag name already owned"); } });
    await expect(store.add(dir)).rejects.toThrow(/already owned/);
    expect(store.installed()).toEqual([]);
  });

  it("takes catalog rows from a bag and imports only the factories when serving models", async () => {
    const dir = join(home, "catalog");
    storeFor("catalog");
    const code = vendorCodeLiteral();
    writeFileSync(join(dir, "bag.yaml"), JSON.stringify({ name: "catalog", description: "Models only", vendors: code.vendors }));
    const store = loadAdapters({ file: join(home, "adapters.json"), importModule: async () => ({ default: { ...adapterLiteral("catalog"), bag: "." }, vendorFactories: code.factories }) });
    const record = await store.add(dir);
    expect(record.bag?.manifest.vendors).toEqual(code.vendors);
    expect(store.vendorRows()).toEqual(code.vendors);
    expect((await store.loadVendorCode()).factories.decision?.acme).toBe(code.factories.decision?.acme);
  });
  it("records the vendor rows at add, readable without loading the adapter", async () => {
    const store = storeFor("first", { vendorCode: vendorCodeLiteral() });
    const record = await store.add(join(home, "first"));
    expect(record.vendorCode?.vendors.map((v) => v.id)).toEqual(["acme"]);
    expect(store.vendorRows().map((v) => v.id)).toEqual(["acme"]);
    // The data half survives a fresh store over the same record — the record
    // is the catalog, not the module instance.
    const reopened = loadAdapters({ file: join(home, "adapters.json") });
    expect(reopened.vendorRows().map((v) => v.id)).toEqual(["acme"]);
  });

  it("loads the factories from the recorded path and serves a decision through them", async () => {
    const store = storeFor("first", { vendorCode: vendorCodeLiteral() });
    await store.add(join(home, "first"));

    const { factories, refused } = await store.loadVendorCode();
    expect(refused.size).toBe(0);
    expect(Object.keys(factories.decision ?? {})).toEqual(["acme"]);

    const models = createModels(assembleVendors(store.vendorRows(), factories));
    const decision = await models.decision("acme/judge").decide({
      state: "a diff",
      questions: { safe: { type: "boolean", instructions: "Is it safe?" } },
    });
    expect(decision.answers.safe).toMatchObject({ type: "boolean", value: true, probability: 0.75 });
    expect(decision.servedModel).toBe("judge-1.0");
  });

  it("refuses vendor code whose factory names a vendor it does not declare", async () => {
    const broken = vendorCodeLiteral();
    (broken.factories.decision as Record<string, unknown>).rival = broken.factories.decision!["acme"];
    const store = storeFor("first", { vendorCode: broken });
    await expect(store.add(join(home, "first"))).rejects.toThrow(AdapterRefused);
    await expect(store.add(join(home, "first"))).rejects.toThrow(/names vendor "rival", which this vendor code does not declare/);
    expect(store.installed()).toEqual([]);
  });

  it("refuses a second adapter claiming a vendor an installed one already declares", async () => {
    const first = storeFor("first", { vendorCode: vendorCodeLiteral() });
    await first.add(join(home, "first"));

    const second = storeFor("second", { vendorCode: vendorCodeLiteral() });
    await expect(second.add(join(home, "second"))).rejects.toThrow(AdapterRefused);
    await expect(second.add(join(home, "second"))).rejects.toThrow(/the vendor acme \(already declared by "first"/);
  });

  it("refuses a non-callable vendor factory before recording its provider", async () => {
    const code = vendorCodeLiteral();
    Object.assign(code.factories.decision!, { acme: "not a function" });
    const store = storeFor("first", { vendorCode: code });
    await expect(store.add(join(home, "first"))).rejects.toThrow("invalid decision factory for acme");
    expect(store.installed()).toEqual([]);
  });

  it("reports an adapter whose code stopped loading rather than failing the caller", async () => {
    const store = storeFor("first", { vendorCode: vendorCodeLiteral() });
    await store.add(join(home, "first"));

    const broken = loadAdapters({
      file: join(home, "adapters.json"),
      importModule: async () => {
        throw new Error("its module no longer imports");
      },
    });
    const { factories, refused } = await broken.loadVendorCode();
    expect(factories.decision).toBeUndefined();
    expect(refused.get("first")?.[0]).toMatch(/could not load; reinstall/);
    expect(refused.get("first")?.[0]).not.toContain("its module no longer imports");
    // The rows survive the failed load: the record is the catalog.
    expect(broken.vendorRows().map((v) => v.id)).toEqual(["acme"]);
  });

  it("re-adding the same adapter replaces its own claim instead of colliding with it", async () => {
    const store = storeFor("first", { vendorCode: vendorCodeLiteral() });
    await store.add(join(home, "first"));
    const record = await store.add(join(home, "first"));
    expect(record.vendorCode?.vendors.map((v) => v.id)).toEqual(["acme"]);
    expect(store.installed()).toHaveLength(1);
  });
});

describe("versioned session selections", () => {
  it.each([undefined, { contractVersion: 2 }])("refuses unsupported package contracts before importing code", async contract => {
    const importModule = vi.fn(async () => ({ default: adapterLiteral("first") }));
    const store = storeFor("first", { importModule });
    const file = join(home, "first", "package.json");
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    pkg.barry.sessionAdapter = contract;
    writeFileSync(file, JSON.stringify(pkg));
    await expect(store.add(join(home, "first"))).rejects.toThrow("unsupported session adapter contract");
    expect(importModule).not.toHaveBeenCalled();
    expect(store.installed()).toEqual([]);
  });

  it.each(["./adapter.ts", "../outside.js"])("refuses unsafe package entry %s before importing", async entry => {
    const importModule = vi.fn(async () => ({ default: adapterLiteral("first") }));
    const store = storeFor("first", { importModule });
    const file = join(home, "first", "package.json");
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    pkg.exports = entry;
    writeFileSync(file, JSON.stringify(pkg));
    await expect(store.add(join(home, "first"))).rejects.toThrow(/compiled ESM|escapes its package/);
    expect(importModule).not.toHaveBeenCalled();
  });

  it("refuses a compiled symlink escaping its package", async () => {
    const importModule = vi.fn(async () => ({ default: adapterLiteral("first") }));
    const store = storeFor("first", { importModule });
    const entry = join(home, "first", "adapter.js");
    const outside = join(home, "outside.js");
    writeFileSync(outside, "export default {};\n");
    rmSync(entry);
    symlinkSync(outside, entry);
    await expect(store.add(join(home, "first"))).rejects.toThrow("escapes its package");
    expect(importModule).not.toHaveBeenCalled();
  });

  it("refuses a missing compiled entry with an install command", async () => {
    const store = storeFor("first");
    rmSync(join(home, "first", "adapter.js"));
    await expect(store.add(join(home, "first"))).rejects.toThrow("npm install @fixture/first");
  });

  it.each(["{", "{}", '[{"contractVersion":0}]'])("preserves an invalid registry instead of treating it as empty", content => {
    const file = join(home, "adapters.json");
    writeFileSync(file, content);
    const store = loadAdapters({ file });
    expect(() => store.installed()).toThrow("invalid installed session registry");
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("lists persisted selections without loading packages or exposing a mutable record", async () => {
    const importModule = vi.fn(async () => ({ default: adapterLiteral("first") }));
    const store = storeFor("first", { importModule });
    await store.add(join(home, "first"));
    importModule.mockClear();
    const records = store.installed();
    records[0].label = "mutated";
    expect(store.installed()[0]?.label).toBe("Fixture first");
    expect(importModule).not.toHaveBeenCalled();
  });

  it("refuses duplicate or colliding persisted ownership claims", async () => {
    const store = storeFor("first");
    const record = await store.add(join(home, "first"));
    writeFileSync(join(home, "adapters.json"), JSON.stringify([record, { ...record, packageName: "other", path: join(home, "other") }]));
    expect(() => store.installed()).toThrow("invalid installed session registry");
  });

  it.each(["id", "alias"])("cannot replace another package's %s", async kind => {
    const first = storeFor("first");
    await first.add(join(home, "first"));
    const second = storeFor("second", { importModule: async () => ({ default: kind === "id" ? adapterLiteral("first") : { ...adapterLiteral("second"), aliases: ["first"] } }) });
    await expect(second.add(join(home, "second"))).rejects.toThrow("already answers");
    expect(first.installed().map(record => record.id)).toEqual(["first"]);
  });

  it("allows an explicitly reselected package to rename its own ID", async () => {
    let renamed = false;
    const store = storeFor("first", { importModule: async () => ({ default: renamed ? { ...adapterLiteral("renamed"), aliases: ["first"] } : adapterLiteral("first") }) });
    await store.add(join(home, "first"));
    renamed = true;
    await expect(store.load("first")).rejects.toThrow("changed its contract, version or declarations");
    await store.add(join(home, "first"));
    expect(store.installed().map(record => record.id)).toEqual(["renamed"]);
    expect((await store.load("first")).id).toBe("renamed");
  });

  it("requires explicit reselection after a package version changes", async () => {
    const store = storeFor("first");
    await store.add(join(home, "first"));
    const file = join(home, "first", "package.json");
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    pkg.version = "2.0.0";
    writeFileSync(file, JSON.stringify(pkg));
    await expect(store.load("first")).rejects.toThrow("barry adapter add");
    expect(store.installed()[0]?.version).toBe("1.0.0");
    await store.add(join(home, "first"));
    expect(store.installed()[0]?.version).toBe("2.0.0");
  });

  it("refuses concurrent add/remove while vetting and retains both later selections", async () => {
    const first = storeFor("first");
    const second = storeFor("second");
    let started!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const adding = first.add(join(home, "first"), { vet: async () => { started(); await waiting; return []; } });
    await ready;
    try {
      await expect(second.add(join(home, "second"))).rejects.toThrow("session-adapters is in use");
      expect(() => second.remove("first")).toThrow("session-adapters is in use");
      expect(first.installed()).toEqual([]);
    } finally { resume(); await adding; }
    await second.add(join(home, "second"));
    expect(first.installed().map(record => record.id)).toEqual(["first", "second"]);
  });

  it("cannot resurrect a selection removed while its module loads", async () => {
    let delayed = false;
    let started!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const store = storeFor("first", { importModule: async () => {
      if (delayed) { started(); await waiting; }
      return { default: adapterLiteral("first") };
    } });
    await store.add(join(home, "first"));
    delayed = true;
    const loading = store.load("first");
    await ready;
    expect(store.remove("first")).toBe(true);
    resume();
    await expect(loading).rejects.toThrow("adapter not installed");
    expect(store.installed()).toEqual([]);
  });

  it("supports concurrent reads without changing or locking the registry", async () => {
    const store = storeFor("first");
    await store.add(join(home, "first"));
    const before = readFileSync(join(home, "adapters.json"), "utf8");
    const loaded = await Promise.all(Array.from({ length: 8 }, () => store.load("first")));
    expect(loaded.map(adapter => adapter.id)).toEqual(Array(8).fill("first"));
    expect(readFileSync(join(home, "adapters.json"), "utf8")).toBe(before);
    expect(existsSync(join(home, "session-adapters.lock"))).toBe(false);
  });

  it("keeps a recorded launch's attachment to the hosted session", async () => {
    const store = storeFor("first");
    await store.add(join(home, "first"));
    const file = join(home, "adapters.json");
    const records = JSON.parse(readFileSync(file, "utf8"));
    records[0].modes.instrumented = { ...records[0].modes.guest, attachesTo: "hosted" };
    writeFileSync(file, JSON.stringify(records));
    expect(store.installed()[0]?.modes.instrumented?.attachesTo).toBe("hosted");
  });

  it("writes private records and removes a selection by alias without deleting files", async () => {
    const store = storeFor("first", { importModule: async () => ({ default: { ...adapterLiteral("first"), aliases: ["old"] } }) });
    await store.add(join(home, "first"));
    expect(statSync(join(home, "adapters.json")).mode & 0o777).toBe(0o600);
    expect(store.remove("old")).toBe(true);
    expect(store.remove("old")).toBe(false);
    expect(existsSync(join(home, "first", "adapter.js"))).toBe(true);
    expect(readdirSync(home).some(name => name.endsWith(".lock") || name.endsWith(".tmp"))).toBe(false);
  });
});
it("snapshots experimental evidence and refuses a changed reason", async () => {
  let experimental = "real API evidence missing";
  const store = storeFor("experimental", { importModule: async () => ({ default: { ...adapterLiteral("experimental"), experimental } }) });
  const record = await store.add(join(home, "experimental"));
  expect(record.experimental).toBe(experimental);
  expect(store.installed()[0].experimental).toBe(experimental);
  experimental = "another missing check";
  await expect(store.load("experimental")).rejects.toThrow("changed its contract");
});
