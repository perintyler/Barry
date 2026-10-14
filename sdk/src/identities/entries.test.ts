import { describe, expect, it } from "vitest";
import { parseTraits, parseBounds, inheritEntries, serializeEntries, requiredNames, optionalNames, ownEntries } from "./entries.js";

describe("identity entries", () => {
  it("parses every reference form, including old string rows", () => {
    const entries = parseTraits(["one", { two: null }, { three: {} }, { four: { optional: true } }, { five: { optional: false } }]);
    expect(requiredNames(entries)).toEqual(["one", "two", "three", "five"]);
    expect(optionalNames(entries)).toEqual(["four"]);
    expect(parseTraits(["old"])).toEqual([{ name: "old", optional: false }]);
  });
  it("normalizes trait definitions with the manifest schema", () => {
    const entries = parseTraits([{ review: { description: "Review", access: "write", namespaces: ["git"], includes: ["read"], nativeTools: { claude: ["Read"] }, bounds: ["quiet"] } }]);
    expect(entries[0].trait).toMatchObject({ access: "readwrite", bags: ["git"], nativeTools: { claude: ["Read"] }, boundNames: ["quiet"] });
    expect(parseTraits(serializeEntries(entries))).toEqual(entries);
  });
  it("round-trips flat bound definitions", () => {
    const entries = parseBounds([{ quiet: { optional: true, description: "Quiet", bash: { denyPrograms: ["git:push"] } } }, "other"]);
    expect(parseBounds(serializeEntries(entries))).toEqual(entries);
  });
  it.each([
    ["mapping", { one: null }], ["two keys", [{ one: null, two: null }]],
    ["list fields", [{ one: [] }]], ["duplicate", ["one", { one: null }]],
    ["qualified definition", [{ "git:one": { description: "One" } }]],
    ["misspelt field", [{ one: { description: "One", boundz: [] } }]],
    ["bad optional", [{ one: { optional: "true" } }]], ["empty name", [""]],
  ])("names the file and invalid trait entry: %s", (_name, raw) => {
    expect(() => parseTraits(raw, "fixture/identity.yaml")).toThrow("fixture/identity.yaml");
  });
  it("refuses a bound without description or with misspelt rules", () => {
    expect(() => parseBounds([{ one: { bash: {} } }], "file")).toThrow("file: bounds entry 1");
    expect(() => parseBounds([{ one: { description: "One", deniedTool: [] } }])).toThrow();
  });
  it("inherits in parent order while references switch optionality", () => {
    const parent = parseTraits([{ one: { optional: true, description: "One" } }, "two"]);
    const merged = inheritEntries(parent, parseTraits(["one", { two: { optional: true } }, "three"]));
    expect(requiredNames(merged)).toEqual(["one", "three"]);
    expect(merged.map(entry => entry.name)).toEqual(["one", "two", "three"]);
    expect(merged[0].trait).toEqual(parent[0].trait);
    expect(parseTraits(serializeEntries(merged))).toEqual(merged);
  });
  it("refuses definitions of a parent's or base's name", () => {
    const own = parseBounds([{ quiet: { description: "Quiet" } }]);
    expect(() => inheritEntries(parseBounds(["quiet"]), own)).toThrow("already named");
    expect(() => inheritEntries([], own, ["quiet"], "child.yaml")).toThrow("child.yaml");
  });
  it("keeps own definitions and optional references on writes", () => {
    const parent = parseTraits(["parent", { offered: { optional: true } }]);
    const own = parseTraits([{ custom: { description: "Custom" } }, { old: { optional: true } }]);
    const written = ownEntries(own, parent, ["offered", "new"]);
    expect(requiredNames(written)).toEqual(["offered", "new"]);
    expect(optionalNames(written)).toEqual(["custom", "old", "parent"]);
    expect(written[0].trait).toEqual(own[0].trait);
    expect(ownEntries(own, parent, null)).toEqual([{ ...own[0], optional: true }]);
  });
});
