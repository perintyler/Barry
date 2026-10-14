import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { SDK_BUNDLED_BUILD } from "./modes.js";
it("names the build bundled in the pinned SDK", () => {
  const require = createRequire(import.meta.url);
  const sdk = JSON.parse(readFileSync(join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8"));
  expect(SDK_BUNDLED_BUILD).toBe(sdk.claudeCodeVersion);
});
