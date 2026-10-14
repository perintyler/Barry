import { defineConfig } from "vitest/config";
import base from "./vitest.base.config.ts";

/**
 * Root config, so that `vitest` run from the repo root is pinned to scratch
 * stores like every per-package run is.
 *
 * Without this file vitest loads NO config at all from the root — per-package
 * configs are only found when vitest's cwd is that package — so the `test.env`
 * pinning in vitest.base.config.ts did not apply and suites resolved to the
 * real stores under ~/.barry. Suites passed either way, so the broken state was
 * invisible while they wrote rows against production. The pinned variable that
 * originally motivated this file was a database URL that no longer exists; the
 * SQLite pins it now carries are guarding the same hazard.
 *
 * `include` is widened from the base's `src/**` because from here the suites
 * live under each workspace, and `test/**` picks up the packages that keep
 * tests there (cli, the bag-owned stores). Worktree copies under .claude/ are stale
 * duplicates of these same files and must not be collected.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["**/src/**/*.test.ts", "**/test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.claude/worktrees/**",
      // Same hazard as .claude/worktrees: `.worktrees/` holds live checkouts of
      // OTHER branches, whose copies of these suites are stale relative to the
      // tree under test. Collected, they report failures belonging to someone
      // else's code — and pass/fail results that no longer mean anything about
      // the checkout you asked about.
      "**/.worktrees/**",
      // `pnpm dev`'s contributor instance: its sessions' worktrees live inside it.
      "**/.barry-dev/**",
      "**/venv/**",
    ],
  },
});
