import { describe, expect, it } from "vitest";
import * as filesystem from "../../bags/filesystem/src/tools.js";
import { filePathParameters } from "../../sdk/src/bounds/tool-guards.js";

describe("declared filesystem tool paths", () => {
  it("guards every path-typed parameter in the actual first-party definitions", () => {
    let checked = 0;
    for (const definition of Object.values(filesystem)) {
      if (!definition || typeof definition !== "object" || !("schema" in definition) || !("name" in definition)) continue;
      const declared = definition as { name: string; schema: Record<string, { description?: string }> };
      for (const [parameter, schema] of Object.entries(declared.schema)) {
        if (!schema.description || !/\bpath\b|directory to search/i.test(schema.description)) continue;
        expect(filePathParameters(declared), `${declared.name}.${parameter}`).toContain(parameter);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });
});
