import { loadModelVendors } from "@barry-rocks/sdk/adapters/models";
/**
 * `barry adapter list`, `check` and `add <path>`, over real adapter packages
 * on disk and a record file in a temp home.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAdapters } from "@barry-rocks/sdk/internal/adapters";
import { addAdapter, checkAdapters, listAdapters, removeAdapter, modelAdapterCommand, formatAdapter, type AdapterCommandDeps } from "./adapter.js";

let root: string;

it("removes a selected adapter while preserving its installed package", async () => {
  const d = deps();
  const path = writePackage("selected");
  await d.adapters.add(path);
  expect(removeAdapter(d, "selected")).toBe(0);
  expect(d.adapters.installed()).toEqual([]);
  expect(existsSync(join(path, "index.mjs"))).toBe(true);
  expect(d.lines.join("\n")).toContain("registered bag data are preserved");
});

it("reports a missing selection without claiming removal", () => {
  const d = deps();
  expect(removeAdapter(d, "missing")).toBe(1);
  expect(d.lines).toEqual(["No adapter selected as missing."]);
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "barry-adapter-cmd-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** An adapter package as plain JS, the way a third party ships one. */
function writePackage(name: string, { broken = false } = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@test/${name}`, version: "1.2.3", type: "module", exports: { ".": { import: "./index.mjs" } }, barry: { sessionAdapter: { contractVersion: 1 } } }));
  writeFileSync(
    join(dir, "index.mjs"),
    `const guarantees = { capture: "post-hoc", delivery: "tool-call", steer: false, interrupt: false, gating: "static", keepsVendorUi: true, identity: "none" };
export default {
  id: ${JSON.stringify(name)}, label: "Fake ${name}",
  requirements: { binary: { command: "fake", versionArgs: ["--version"], versionPattern: "${broken ? "v(\\\\d+)" : "(\\\\d+\\\\.\\\\d+\\\\.\\\\d+)"}",
    install: { fallback: "nothing to install" }, pin: { version: "2.0.1", enforcedBy: "a test" } } },
  capabilities: { mcpTransports: ["stdio"], toolDenial: "none", systemPromptFormat: "raw", skillsMount: "none", withoutKey: "unauthenticated", endpoint: "fixed" },
  tools: [], defaultMode: "guest",
  modes: { hosted: null, instrumented: null, guest: { guarantees, verifiedOn: "2.0.1", platforms: ["darwin"],
    evidence: { check: "a test", proves: "nothing" }, egressSandbox: false,
    plan: async (config) => ({ command: "fake", args: [], env: config.env, tmpDirs: [], guarantees, warnings: [] }) } },
};
`,
  );
  return dir;
}

function deps(): AdapterCommandDeps & { lines: string[] } {
  const lines: string[] = [];
  return { adapters: loadAdapters({ file: join(root, "home", "adapters.json") }), write: (line) => lines.push(line), lines };
}

describe("listing what is installed", () => {
  it("says plainly when nothing is installed, and how to add one", async () => {
    const d = deps();
    expect(await listAdapters(d)).toBe(0);
    expect(d.lines.join("\n")).toMatch(/No adapters installed\. `barry adapter add <path>`/);
  });

  it("shows an installed adapter's modes, verified build and platforms", async () => {
    const d = deps();
    await d.adapters.add(writePackage("fake"));
    expect(await listAdapters(d)).toBe(0);
    expect(d.lines).toEqual(
      expect.arrayContaining([
        "fake  (Fake fake)",
        "  modes    guest  default: guest",
        "  verified 2.0.1",
        "  platforms darwin",
        "1 adapter(s) installed, 0 with problems.",
      ]),
    );
  });

  it("counts a recorded adapter whose package no longer loads, and keeps listing the rest", async () => {
    const d = deps();
    await d.adapters.add(writePackage("fine"));
    await d.adapters.add(writePackage("gone"));
    rmSync(join(root, "gone"), { recursive: true, force: true });
    expect(await listAdapters(d)).toBe(1);
    expect(d.lines.join("\n")).toMatch(/fine {2}\(Fake fine\)/);
    expect(d.lines.join("\n")).toMatch(/gone {2}\(Fake gone\)[\s\S]*PROBLEM/);
  });
});

describe("checking installed adapters", () => {
  it("passes one that still holds up, and checks just one when asked", async () => {
    const d = deps();
    await d.adapters.add(writePackage("fake"));
    expect(await checkAdapters(d, "fake")).toBe(0);
    expect(d.lines).toEqual(["ok    fake", "1 checked, 0 failed."]);
  });

  it("says so when asked about an adapter that is not here", async () => {
    const d = deps();
    expect(await checkAdapters(d, "codex")).toBe(1);
    expect(d.lines).toEqual(["no adapter named codex"]);
  });
});

describe("adding an adapter by path", () => {
  it("records a sound package", async () => {
    const d = deps();
    expect(await addAdapter({ ...d, vet: async () => [] }, writePackage("fake"))).toBe(0);
    expect(d.adapters.installed().map((record) => record.id)).toEqual(["fake"]);
  });

  it("refuses one whose declarations do not hold up, recording nothing", async () => {
    const d = deps();
    expect(await addAdapter({ ...d, vet: async () => [] }, writePackage("broken", { broken: true }))).toBe(1);
    expect(d.lines.join("\n")).toMatch(/versionPattern/);
    expect(d.adapters.installed()).toEqual([]);
  });

  it("refuses one this machine cannot run, recording nothing", async () => {
    const d = deps();
    expect(await addAdapter({ ...d, vet: async () => ["fake not found on PATH — nothing to install"] }, writePackage("fake"))).toBe(1);
    expect(d.lines).toContain("  fake not found on PATH — nothing to install");
    expect(d.adapters.installed()).toEqual([]);
  });
});


describe("model adapter refusals", () => {
  function modelDeps() {
    const lines: string[] = [];
    const providers = loadModelVendors({ file: join(root, "model-providers.json") });
    return { providers, shipped: [{ packageName: "shipped" }], lines, write: (line: string) => lines.push(line) };
  }
  function modelPackage(name: string) {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "package.json"), JSON.stringify({
      name, version: "1.0.0", type: "module", exports: "./index.js",
      barry: { modelProvider: { contractVersion: 1, factoryExport: "FACTORIES" } },
    }));
    writeFileSync(join(path, "index.js"), `export const FACTORIES = { completion: { ${name}: () => ({}) } };`);
    return path;
  }
  it("lists refused selections with setup and remove hints", async () => {
    const d = modelDeps();
    const shipped = modelPackage("shipped"); const third = modelPackage("third");
    await d.providers.add(shipped); await d.providers.add(third);
    rmSync(join(shipped, "index.js")); rmSync(join(third, "index.js"));
    expect(await modelAdapterCommand(d, "list")).toBe(2);
    expect(d.lines.join("\n")).toContain("barry adapter model remove shipped, then barry setup");
    expect(d.lines.join("\n")).toContain("barry adapter model remove third");
    d.lines.length = 0;
    expect(await modelAdapterCommand(d, "check", "third")).toBe(1);
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toContain("barry adapter model remove third");
  });
  it("hints the build for a shipped record whose compiled entry is gone", async () => {
    const d = modelDeps();
    const shipped = modelPackage("shipped");
    await d.providers.add(shipped, { shipped: true });
    // Setup leaves a current record alone, so only a build repairs it.
    rmSync(join(shipped, "index.js"));
    expect(await modelAdapterCommand(d, "list")).toBe(1);
    expect(d.lines.at(-1)).toContain("run pnpm build:packages, then barry setup");
  });
  it("prints failed add and check as single errors with hints", async () => {
    const d = modelDeps();
    expect(await modelAdapterCommand(d, "add", join(root, "absent"))).toBe(1);
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toContain("barry adapter model add");
    d.lines.length = 0;
    expect(await modelAdapterCommand(d, "check", "absent")).toBe(1);
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toContain("barry adapter model list");
  });
  it("prints removal failures without throwing and preserves package files on success", async () => {
    const d = modelDeps();
    const path = modelPackage("third"); await d.providers.add(path);
    writeFileSync(join(root, "model-providers.lock"), String(process.pid));
    expect(await modelAdapterCommand(d, "remove", "third")).toBe(1);
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toContain("in use");
    rmSync(join(root, "model-providers.lock"));
    expect(await modelAdapterCommand(d, "remove", "third")).toBe(0);
    expect(existsSync(join(path, "index.js"))).toBe(true);
    expect(await modelAdapterCommand(d, "remove", "third")).toBe(1);
  });
});

it("prints the experimental reason after verified", async () => {
  const d = deps();
  const record = await d.adapters.add(writePackage("experimental"));
  const lines = formatAdapter({ ...record, experimental: "real API evidence missing" });
  expect(lines.find(line => line.startsWith("  experimental"))).toBe("  experimental real API evidence missing");
});
