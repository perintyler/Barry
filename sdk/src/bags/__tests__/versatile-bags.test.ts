import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifestObject } from "../manifest.js";
import { resolveConstants } from "../constants.js";

const base = { name: "guardrails", description: "Only declarations" };
describe("versatile bag declarations", () => {
  it("resolves a parent bag's local child relative to that parent", () => {
    const dir = mkdtempSync(join(tmpdir(), "bag-nested-constants-"));
    try {
      mkdirSync(join(dir, "shared", "leaf"), { recursive: true });
      writeFileSync(join(dir, "shared/bag.yaml"), JSON.stringify({ name: "shared", description: "Parent", bags: { leaf: { path: "./leaf" } }, constants: { prose: { constant: "leaf:prose" } } }));
      writeFileSync(join(dir, "shared/leaf/bag.yaml"), JSON.stringify({ name: "leaf", description: "Nested child", constants: { prose: "Nested text" } }));
      const manifest = parseManifestObject({ ...base, bags: { shared: { path: "./shared" } }, instructions: { constant: "shared:prose" } }, "test", dir);
      expect(manifest.instructions).toBe("Nested text");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("reads a declared local constant bag before it is registered", () => {
    const dir = mkdtempSync(join(tmpdir(), "bag-constants-"));
    try {
      mkdirSync(join(dir, "shared"));
      writeFileSync(join(dir, "shared/bag.yaml"), "name: shared\ndescription: Constants only\nconstants:\n  prose: Reusable text\n");
      const manifest = parseManifestObject({ ...base, bags: { shared: { path: "./shared" } }, instructions: { constant: "shared:prose" } }, "test", dir);
      expect(manifest.instructions).toBe("Reusable text");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("accepts a bounds-only bag, qualifying its bound names", () => {
    const manifest = parseManifestObject({ ...base, bounds: { shell: { description: "No shell", bound: { tools: { deny: ["test:shell"] } } } } });
    expect(manifest.tools).toEqual([]);
    expect(manifest.bounds["guardrails:shell"]?.bound).toEqual({ tools: { deny: ["test:shell"] } });
    // Bare names are the identity's; a bag cannot hand one out.
    expect(manifest.bounds.shell).toBeUndefined();
  });

  it("refuses the alias keys that used to publish bare names", () => {
    expect(() => parseManifestObject({ ...base, bounds: { shell: { description: "No shell", bound: {} } }, "bound-aliases": { shell: "shell" } })).toThrow();
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
    expect(() => resolveConstants({ ...base, bags: ["other"], constants: { a: { constant: "other:b" } } }, () => ({ name: "other", bags: ["guardrails"], constants: { b: { constant: "guardrails:a" } } }))).toThrow(/cycle/);
  });
});
