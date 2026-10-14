import { mergeConfig } from "vitest/config";
import base from "../../vitest.base.config.ts";

/**
 * `bookkeeping-shape.contract.test.ts` is a deliberately manual check against a
 * store with REAL sessions in it: it scans 40 sessions looking for real message
 * rows, which times out against a near-empty test store. It gates itself on
 * CONTRACT_TESTS plus the real store file existing (see that file's header), so
 * it is excluded from a normal run:
 *
 *   CONTRACT_TESTS=1 \
 *     pnpm --filter @barry-rocks/sessions-bag exec vitest run \
 *     src/bookkeeping-shape.contract.test.ts
 */
const CONTRACT_TESTS = Boolean(process.env.CONTRACT_TESTS);

export default mergeConfig(base, {
  test: {
    // The base glob is `src/**/*.test.ts`, which silently skips every other
    // root this bag keeps tests in: 21 test files under `api/src` once never
    // ran, and neither did the session-tracker's under `hooks/`. A test that
    // passes locally while never running in a suite is a check that cannot
    // fail, so each root is listed.
    include: ["src/**/*.test.ts", "api/src/**/*.test.ts", "hooks/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(CONTRACT_TESTS ? [] : ["src/bookkeeping-shape.contract.test.ts"]),
    ],
  },
});
