import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { CliError } from "./../lib/cli-error.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep creation off the real machine: a scratch home and identities store per
// instance (below), and no shim dir, so nothing lands on PATH.
vi.mock("../lib/identity-shims.js", () => ({
  getShimDir: vi.fn(() => null),
  findInstalledBarry: vi.fn(() => null),
  installShim: vi.fn(),
  describeConflict: vi.fn(),
}));

import { Barry } from "@barry-rocks/sdk";
import { identities, identityRecords } from "@barry-rocks/identities-bag";
import { closeIdentitiesStore } from "@barry-rocks/identities-bag/testing";

import { provisionOwner } from "../../test/helpers/identities.js";
import { heirCommand } from "./heir.js";
import { identityCreateCommand, nameIdentity } from "./identity-create.js";

/** Every file under `dir`, relative, with its contents. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(dir.length + 1)] = readFileSync(path, "utf-8");
  }
  return out;
}

describe("nameIdentity", () => {
  it("keeps the name as typed and slugs it", () => {
    expect(nameIdentity("B. Goode")).toEqual({ name: "B. Goode", slug: "bgoode" });
    expect(nameIdentity("default")).toEqual({ name: "default", slug: "default" });
  });

  it("rejects a name that slugs to nothing", () => {
    expect(nameIdentity("!!!")).toBeNull();
  });
});

/**
 * A fresh instance: its own home and identities store, with an owner, and a
 * bag registry snapshot for the identity's bag list to be checked against.
 * Creating an identity writes its row, so two instances must not share one
 * store. The registry names none of the base identity's bags, so the new
 * identity's row is written without loading and building every one of them
 * for their traits, which is not what these tests are about.
 */
function freshInstance(): void {
  closeIdentitiesStore();
  const home = mkdtempSync(join(tmpdir(), "barry-home-"));
  process.env.BARRY_HOME = home;
  process.env.BARRY_IDENTITIES_DB = join(home, "identities.db");
  mkdirSync(join(home, "app-support"), { recursive: true });
  writeFileSync(join(home, "app-support", "bags.snapshot.json"), JSON.stringify({ bags: { "zz-unused": { type: "remote", url: "https://example.test/mcp" } } }));
  provisionOwner();
}

describe("barry identity create", () => {
  const originalHome = process.env.BARRY_HOME;
  const originalStore = process.env.BARRY_IDENTITIES_DB;
  const originalCwd = process.cwd();
  let scratch: string;

  beforeEach(() => {
    Barry.use(identities);
    freshInstance();
    scratch = mkdtempSync(join(tmpdir(), "barry-create-"));
    process.chdir(scratch);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    Barry.reset();
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    closeIdentitiesStore();
    if (originalHome === undefined) delete process.env.BARRY_HOME;
    else process.env.BARRY_HOME = originalHome;
    if (originalStore === undefined) delete process.env.BARRY_IDENTITIES_DB;
    else process.env.BARRY_IDENTITIES_DB = originalStore;
  });

  it("produces exactly what heir produces for the same name", async () => {
    await identityCreateCommand("B. Goode", { dir: join(scratch, "via-create") });
    const created = snapshot(join(scratch, "via-create"));

    // A fresh instance, so heir does not refuse the name create just took.
    freshInstance();
    await heirCommand(["to", "the", "B.", "Goode", "empire"], { dir: join(scratch, "via-heir") });

    expect(Object.keys(created).sort()).toEqual([".env", ".gitignore", "identity.yaml"]);
    expect(created["identity.yaml"]).toContain("name: bgoode");
    expect(created["identity.yaml"]).toContain("displayName: Barry B. Goode");
    expect(created).toEqual(snapshot(join(scratch, "via-heir")));
    expect(existsSync(join(scratch, "via-create", "bags"))).toBe(true);
  });

  it("defaults to ./barry-<slug> in the cwd, like heir", async () => {
    await identityCreateCommand("B. Goode");
    expect(existsSync(join(scratch, "barry-bgoode", "identity.yaml"))).toBe(true);
    expect(identityRecords.directory({ name: "bgoode" })).toBe(join(process.cwd(), "barry-bgoode"));
  });

  it("creates into --dir and registers it there", async () => {
    const dir = join(scratch, "elsewhere", "mine");
    await identityCreateCommand("default", { dir });
    expect(existsSync(join(dir, "identity.yaml"))).toBe(true);
    expect(existsSync(join(scratch, "barry-default"))).toBe(false);
    expect(identityRecords.directory({ name: "default" })).toBe(dir);
  });

  it("refuses a name that already exists, leaving the original untouched", async () => {
    const dir = join(scratch, "first");
    await identityCreateCommand("Bucks", { dir });
    const before = snapshot(dir);

    await expect(identityCreateCommand("Bucks", { dir: join(scratch, "second") })).rejects.toThrow(`Barry "bucks" already exists at ${dir}`);
    expect(existsSync(join(scratch, "second"))).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });

  it("refuses digits before vault provisioning or identity creation", async () => {
    const directory = join(scratch, "numeric");
    await expect(identityCreateCommand("3", { dir: directory, email: "numeric@example.test" })).rejects.toThrow(CliError);
    expect(existsSync(directory)).toBe(false);
    expect((await identityRecords.list()).some(entry => entry.record.name === "3")).toBe(false);
  });

  it("refuses a name with nothing to slug", async () => {
    await expect(identityCreateCommand("!!!")).rejects.toThrow(CliError);
    expect(readdirSync(scratch)).toEqual([]);
  });

  /** Everything console.log printed, one string per call. */
  const printed = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0]));

  it("speaks plainly, while heir keeps its flavor", async () => {
    await identityCreateCommand("B. Goode", { dir: join(scratch, "c") });
    expect(printed()).toContain("\nCreating identity B. Goode...\n");
    expect(printed()).toContain("\nIdentity B. Goode is ready.\n");
    expect(printed().join("\n")).not.toMatch(/Birthing|Barry B\. Goode is ready/);

    vi.mocked(console.log).mockClear();
    freshInstance();
    await heirCommand(["to", "the", "B.", "Goode", "empire"], { dir: join(scratch, "h") });
    expect(printed()).toContain("\nBirthing Barry B. Goode...\n");
    expect(printed()).toContain("\nBarry B. Goode is ready.\n");
  });

  it("aligns every hint's command in one column, including 'Run as'", async () => {
    // A shim that installs, so the "Run as <slug>:" line is printed too.
    const shims = await import("../lib/identity-shims.js");
    vi.mocked(shims.getShimDir).mockReturnValueOnce(join(scratch, "bin"));
    vi.mocked(shims.findInstalledBarry).mockReturnValueOnce("/usr/local/bin/barry");
    vi.mocked(shims.installShim).mockReturnValueOnce({ name: "zzcreateprobe", status: "installed" });

    await identityCreateCommand("zz-create-probe", { dir: join(scratch, "z") });
    const hints = printed().filter((line) => /^ {2}(Run as|Install bags|Use everywhere|Use in this repo)/.test(line));
    expect(hints.map((line) => line.split(":")[0].trim())).toEqual([
      "Run as zzcreateprobe",
      "Install bags",
      "Use everywhere",
      "Use in this repo",
    ]);
    const columns = new Set(hints.map((line) => line.search(/(zzcreateprobe <command>|git clone|barry use)/)));
    expect(columns.size).toBe(1);
  });

  it("closes with hints that name real commands", async () => {
    await identityCreateCommand("Bucks", { dir: join(scratch, "b") });
    const printed = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("barry use bucks");
    expect(printed).toContain("barry use bucks --local");
    expect(printed).not.toContain("heir");
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).not.toContain("config import");
  });
});
