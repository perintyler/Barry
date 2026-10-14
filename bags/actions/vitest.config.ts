import { mergeConfig } from "vitest/config";
import base from "../../vitest.base.config.ts";

// The base glob is `src/**`, which would silently skip the web service's
// tests — they live under server/src/ so the service is self-contained.
export default mergeConfig(base, {
  test: { include: ["src/**/*.test.ts", "server/src/**/*.test.ts"] },
});
