import { defineConfig } from "vitest/config";
import base from "../../vitest.base.config.ts";

// Include root tool tests as well as src tests so the public tool contract is exercised.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-237
export default defineConfig({
  test: {
    // Everything else from the base: above all its scratch instance home.
    // Without it these suites wrote their usage rows into the real instance's
    // usage.db, which is how 64 synthetic sessions landed in one.
    ...base.test,
    include: ["src/**/*.test.ts", "web/**/*.test.js"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
