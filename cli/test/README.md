# CLI test platform assumptions

The CLI suite must pass on POSIX environments, including Linux and macOS.
Build workspace packages before running it: `pnpm install --frozen-lockfile && pnpm build:packages`.

Platform assumptions the suite must not make:

- Codex homes do not always live under `/private/tmp`. Normalize the adapter runtime’s `codexHomesRoot()` so expectations follow its root on either platform.
- The running Node binary does not always live under `/opt/homebrew/bin`. Service PATH expectations must account for the directory of `stableNodePath()` and retain assertions for the remaining search directories.
- The external `trash` executable is optional. Test cleanup must handle its absence without touching user data, and a test must exercise that path.

Run `pnpm --dir cli test` on both Linux and macOS before reporting cross-platform verification.
