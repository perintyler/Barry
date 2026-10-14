import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * SES-23: the OTLP receiver must log through the structured logger, not
 * `console.*`, so its lines land in the same sink as the rest of the service
 * rather than escaping it. A source-level guard: the behaviour under test is
 * which log function the file calls, which a request-level test cannot see.
 */
describe("OTLP receiver logging channel", () => {
  const source = readFileSync(fileURLToPath(new URL("./otlp.ts", import.meta.url)), "utf8");

  it("creates a structured logger", () => {
    expect(source).toMatch(/createLogger/);
  });

  it("does not log through console", () => {
    // Strip line comments so a mention of `console` in prose does not trip this.
    const code = source.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bconsole\.(log|error|warn|info|debug)\s*\(/);
  });
});
