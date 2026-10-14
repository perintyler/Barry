import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadRegistry, loadBuiltinRegistry, isBuiltinBag, listBagNames, RegistrySnapshotError } from "../registry.js";
import { addSnapshotBag, removeSnapshotBag } from "./snapshot-fixture.js";

describe("registry", () => {
  let tmpDir: string;
  let snapshotPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bags-test-"));
    snapshotPath = join(tmpDir, "bags.snapshot.json");
    process.env.BARRY_BAGS_SNAPSHOT = snapshotPath;
    // An EMPTY builtin dir means "no builtins"; a missing one is a loud error.
    mkdirSync(join(tmpDir, "no-builtins"), { recursive: true });
    process.env.BARRY_BUILTIN_DIR = join(tmpDir, "no-builtins");
  });

  afterEach(() => {
    delete process.env.BARRY_BAGS_SNAPSHOT;
    delete process.env.BARRY_BUILTIN_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws, naming the fix, when the snapshot is missing", () => {
    expect(() => loadRegistry()).toThrow(RegistrySnapshotError);
    expect(() => loadRegistry()).toThrow(/barry bag doctor --fix|barry up/);
  });

  it("never reads a bags.yaml standing next to a missing snapshot", () => {
    // Only the generated snapshot authorizes registry reads.
    // Rationale: docs/decisions/0032-sdk-contract-regression-history.md.
    writeFileSync(join(tmpDir, "bags.yaml"), "linear:\n  type: remote\n  url: https://mcp.linear.app/mcp\n");
    expect(() => loadRegistry()).toThrow(RegistrySnapshotError);
  });

  it("throws on a snapshot that cannot be parsed", () => {
    writeFileSync(snapshotPath, "{ truncated");
    expect(() => loadRegistry()).toThrow(/could not be parsed/);
  });

  it("throws on a snapshot with no bags table", () => {
    writeFileSync(snapshotPath, JSON.stringify({ generated: "x" }));
    expect(() => loadRegistry()).toThrow(/no bags table/);
  });

  it("throws on a snapshot that registers no bags, rather than reporting an empty machine", () => {
    writeFileSync(snapshotPath, JSON.stringify({ bags: {} }));
    expect(() => loadRegistry()).toThrow(/registers no bags/);
  });

  it("loads the bags the snapshot registers", () => {
    addSnapshotBag("linear", { type: "remote", url: "https://mcp.linear.app/mcp" });
    addSnapshotBag("toolbox", { type: "local", path: "/repos/toolbox" });
    const reg = loadRegistry();
    expect(Object.keys(reg)).toEqual(["linear", "toolbox"]);
    expect(reg.linear).toEqual({ type: "remote", url: "https://mcp.linear.app/mcp" });
    expect(reg.toolbox).toEqual({ type: "local", path: "/repos/toolbox" });
  });

  it("drops a malformed entry without unregistering the others", () => {
    addSnapshotBag("good", { type: "local", path: "/good" });
    addSnapshotBag("no-path", { type: "local" });
    expect(Object.keys(loadRegistry())).toEqual(["good"]);
  });

  it("reflects a removed bag on the next read", () => {
    addSnapshotBag("keep", { type: "local", path: "/keep" });
    addSnapshotBag("to-remove", { type: "remote", url: "http://example.com" });
    expect(removeSnapshotBag("to-remove")).toBe(true);
    expect(loadRegistry()["to-remove"]).toBeUndefined();
  });

  it("lists bag names", () => {
    addSnapshotBag("a", { type: "local", path: "/a" });
    addSnapshotBag("b", { type: "remote", url: "http://b" });
    expect(listBagNames()).toEqual(["a", "b"]);
  });

  /** A builtin directory: one folder per `local` name, each with its bag.yaml. */
  function builtinFixture(opts: { local?: string[] }): string {
    const dir = join(tmpDir, "bags");
    mkdirSync(dir, { recursive: true });
    for (const name of opts.local ?? []) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "bag.yaml"), `name: ${name}\ndescription: fixture bag\n`);
    }
    process.env.BARRY_BUILTIN_DIR = dir;
    return dir;
  }

  it("does not add builtin bags the snapshot does not register", () => {
    // config.db (and so the snapshot) holds every installed bag, builtin ones
    // included; the builtin directory is not a second source of registrations.
    builtinFixture({ local: ["git"] });
    addSnapshotBag("my-tool", { type: "local", path: "/my/tool" });
    expect(Object.keys(loadRegistry())).toEqual(["my-tool"]);
  });

  it("isBuiltinBag identifies builtin bags", () => {
    // A builtin is a bag SHIPPED WITH BARRY: a bag.yaml inside the builtin
    // directory. A remote server or a user bag is never builtin.
    const dir = builtinFixture({ local: ["git"] });
    addSnapshotBag("my-tool", { type: "local", path: "/my/tool" });

    const reg = loadBuiltinRegistry();
    expect(reg.git).toEqual({ type: "local", path: join(dir, "git") });
    expect(isBuiltinBag("git")).toBe(true);
    expect(isBuiltinBag("sentry")).toBe(false);
    expect(isBuiltinBag("my-tool")).toBe(false);
    // The base identity is not a bag.
    expect(isBuiltinBag("barry")).toBe(false);
  });

  it("isBuiltinBag follows a change of builtin directory", () => {
    builtinFixture({ local: ["git"] });
    expect(isBuiltinBag("git")).toBe(true);
    process.env.BARRY_BUILTIN_DIR = join(tmpDir, "no-builtins");
    expect(isBuiltinBag("git")).toBe(false);
  });
});
