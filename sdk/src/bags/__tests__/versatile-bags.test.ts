import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifestObject } from "../manifest.js";
import { resolveConstants } from "../constants.js";

const base = { name: "policy", description: "Only declarations" };
describe("versatile bag declarations", () => {
  it("resolves a provider's local child relative to that provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "bag-nested-constants-"));
    try {
      mkdirSync(join(dir, "shared", "leaf"), { recursive: true });
      writeFileSync(join(dir, "shared/bag.yaml"), JSON.stringify({ name: "shared", description: "Provider", bags: { leaf: { path: "./leaf" } }, constants: { prose: { constant: "leaf:prose" } } }));
      writeFileSync(join(dir, "shared/leaf/bag.yaml"), JSON.stringify({ name: "leaf", description: "Nested provider", constants: { prose: "Nested text" } }));
      const manifest = parseManifestObject({ ...base, bags: { shared: { path: "./shared" } }, instructions: { constant: "shared:prose" } }, "test", dir);
      expect(manifest.instructions).toBe("Nested text");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("reads a declared local constant provider before it is registered", () => {
    const dir = mkdtempSync(join(tmpdir(), "bag-constants-"));
    try {
      mkdirSync(join(dir, "shared"));
      writeFileSync(join(dir, "shared/bag.yaml"), "name: shared\ndescription: Constants only\nconstants:\n  prose: Reusable text\n");
      const manifest = parseManifestObject({ ...base, bags: { shared: { path: "./shared" } }, instructions: { constant: "shared:prose" } }, "test", dir);
      expect(manifest.instructions).toBe("Reusable text");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("accepts a policy-only compound, qualifying its names", () => {
    const manifest = parseManifestObject({ ...base, bounds: { shell: { description: "No shell", bound: { nativeTools: { test: ["shell"] } } } }, traits: { shell: { description: "No shell", bounds: ["shell"] }, restricted: { description: "Compound", includes: ["shell"] } } });
    expect(manifest.tools).toEqual([]);
    expect(manifest.traits["policy:restricted"]?.includes).toEqual(["policy:shell"]);
    expect(manifest.traits["policy:shell"]?.boundNames).toEqual(["policy:shell"]);
    // Bare names are the identity's; a bag cannot hand one out.
    expect(manifest.traits.restricted).toBeUndefined();
  });

  it("refuses the alias keys that used to publish bare names", () => {
    expect(() => parseManifestObject({ ...base, traits: { shell: { description: "No shell" } }, "trait-aliases": { shell: "shell" } })).toThrow();
  });
  it("resolves constants before validating substituted fields", () => {
    expect(parseManifestObject({ ...base, constants: { prose: "Use these instructions" }, instructions: { constant: "prose" } }).instructions).toBe("Use these instructions");
    expect(() => parseManifestObject({ ...base, constants: { prose: 12 }, instructions: { constant: "prose" } })).toThrow(/instructions/);
  });
  it("resolves declared cross-bag references without interpolation", () => {
    const raw = { ...base, bags: ["shared"], constants: { prompt: { constant: "shared:prompt" } }, instructions: { constant: "prompt" } };
    expect(resolveConstants(raw, () => ({ name: "shared", constants: { prompt: "literal ${KEY}" } }))).toMatchObject({ instructions: "literal ${KEY}" });
    expect(() => resolveConstants({ ...raw, bags: [] }, () => ({}))).toThrow(/must compose or require/);
  });
  it("refuses absent references and cycles", () => {
    expect(() => resolveConstants({ ...base, instructions: { constant: "missing" } }, () => ({}))).toThrow(/unknown constant/);
    expect(() => resolveConstants({ ...base, constants: { a: { constant: "b" }, b: { constant: "a" } } }, () => ({}))).toThrow(/cycle/);
    expect(() => resolveConstants({ ...base, bags: ["other"], constants: { a: { constant: "other:b" } } }, () => ({ name: "other", bags: ["policy"], constants: { b: { constant: "policy:a" } } }))).toThrow(/cycle/);
  });
});
