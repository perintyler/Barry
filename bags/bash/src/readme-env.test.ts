import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * BAG-25: the two bash env knobs were only discoverable by reading the
 * executor. The README must name both, and the documented defaults must match
 * the source so the doc cannot silently rot.
 */
describe("bash README documents its env knobs (BAG-25)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const readme = readFileSync(join(here, "..", "README.md"), "utf8");
  const executor = readFileSync(join(here, "executor.ts"), "utf8");

  it("names both environment variables", () => {
    expect(readme).toContain("BASH_OUTPUT_LIMIT");
    expect(readme).toContain("BASH_DEFAULT_TIMEOUT");
  });

  it("documents defaults that match the executor source", () => {
    // These are the literals the executor falls back to.
    expect(executor).toContain('process.env.BASH_OUTPUT_LIMIT || "51200"');
    expect(executor).toContain('process.env.BASH_DEFAULT_TIMEOUT || "120000"');
    expect(readme).toContain("51200");
    expect(readme).toContain("120000");
  });
});
