import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { CliError } from "../src/lib/cli-error.js";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const scratch = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? "/tmp"}/pack-extension-${process.pid}-${Date.now()}`;
  process.env.BARRY_HOME = `${root}/home`;
  process.env.BARRY_IDENTITIES_DB = `${root}/identities.db`;
  process.env.BARRY_BAGS_SNAPSHOT = `${root}/bags.snapshot.json`;
  process.env.BARRY_BUILTIN_DIR = `${root}/no-builtins`;
  return { root };
});
vi.mock("../src/bags/registration.js", () => ({
  getBag: vi.fn(async (name: string) => ["sessions", "sessions/search"].includes(name) ? ({ name, source: { type: "local", path: join(scratch.root, name) }, builtin: false }) : null),
  listBags: vi.fn(async () => ["sessions", "sessions/search"].map((name) => ({ name, source: { type: "local", path: join(scratch.root, name) }, builtin: false }))),
  upsertBag: vi.fn(), deleteBag: vi.fn(), writeRegistrySnapshot: vi.fn(),
}));
vi.mock("../src/commands/service.js", () => ({ reconcileServices: vi.fn(async () => ({ started: [], stopped: [] })), restartManagedService: vi.fn() }));
import { bagPackCommand, bagUnpackCommand, bagInstallCommand, bagShowCommand } from "../src/commands/bag.js";
import { Barry } from "@barry-rocks/sdk";
import { identities, identityRecords } from "@barry-rocks/identities-bag";
import { provisionOwner } from "./helpers/identities.js";

let dir: string;
const file = () => join(dir, "identity.yaml");
const rowBags = async () => (await identityRecords.row((await identityRecords.find("extensiontester")).record.id))?.metadata.bags ?? [];

beforeAll(() => {
  Barry.use(identities);
  mkdirSync(join(scratch.root, "no-builtins"), { recursive: true });
  const bags: Record<string, unknown> = {};
  for (const [name, manifest] of [["sessions", "name: sessions\ndescription: Sessions\n"], ["sessions/search", "name: search\nextends: sessions\ndescription: Search\n"]]) {
    const path = join(scratch.root, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "bag.yaml"), manifest);
    bags[name] = { type: "local", path };
  }
  writeFileSync(process.env.BARRY_BAGS_SNAPSHOT!, JSON.stringify({ generated: new Date().toISOString(), source: "test", bags }));
  provisionOwner("Extension Tester");
  dir = join(process.env.BARRY_HOME!, "app-support", "identities", "extensiontester");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(), "name: extensiontester\nbags: []\n");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
});
afterAll(() => {
  Barry.reset();
  vi.restoreAllMocks();
  rmSync(scratch.root, { recursive: true, force: true });
});

describe("packing extensions", () => {
  it("installs the registered extension name and refuses --as", async () => {
    const { upsertBag } = await import("../src/bags/registration.js");
    const path = join(scratch.root, "sessions/search");
    await expect(bagInstallCommand(path, { as: "alias" })).rejects.toThrow(CliError);
    expect(upsertBag).not.toHaveBeenCalled();
    expect(await bagInstallCommand(path)).toBe("sessions/search");
    expect(upsertBag).toHaveBeenCalledWith("sessions/search", { type: "local", path });
  });
  it("shows the registered extensions on their parent", async () => {
    await bagShowCommand("sessions");
    expect(console.log).toHaveBeenCalledWith("Extensions: sessions/search");
  });
  it("requires the parent and leaves the file unchanged", async () => {
    const before = readFileSync(file(), "utf8");
    await expect(bagPackCommand("sessions/search", { name: "extensiontester" })).rejects.toThrow(/Pack sessions first/);
    expect(readFileSync(file(), "utf8")).toBe(before);
    expect(await rowBags()).toEqual([]);
  });
  it("suggests the registered name when only the short name was given", async () => {
    await expect(bagPackCommand("search", { name: "extensiontester" })).rejects.toThrow(/sessions\/search/);
  });
  it("packs the parent then the extension in the nested file form", async () => {
    await bagPackCommand("sessions", { name: "extensiontester" });
    await bagPackCommand("sessions/search", { name: "extensiontester" });
    expect(parse(readFileSync(file(), "utf8")).bags).toEqual([{ sessions: { extensions: ["search"] } }]);
    expect(await rowBags()).toEqual(["sessions", "sessions/search"]);
  });
  it("unpacks both but keeps a parent registered while its extension is registered", async () => {
    const { deleteBag } = await import("../src/bags/registration.js");
    await bagUnpackCommand("sessions", { name: "extensiontester", unregister: true });
    expect(deleteBag).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("has registered extensions: sessions/search"));
    expect(parse(readFileSync(file(), "utf8")).bags).toEqual([]);
    expect(await rowBags()).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Extensions unpacked: sessions/search"));
  });
  it("packs through an inherited parent and writes that parent into the child's file", async () => {
    const root = join(process.env.BARRY_HOME!, "app-support", "identities");
    for (const [name, yaml] of [["extensionparent", "name: extensionparent\nbags: [sessions]\n"], ["extensionchild", "name: extensionchild\ninherits: extensionparent\n"]]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "identity.yaml"), yaml);
    }
    await bagPackCommand("sessions/search", { name: "extensionchild" });
    expect(parse(readFileSync(join(root, "extensionchild", "identity.yaml"), "utf8")).bags).toEqual([{ sessions: { extensions: ["search"] } }]);
    expect((await identityRecords.find("extensionchild")).record.metadata.bags).toEqual(["sessions", "sessions/search"]);
  });

});
