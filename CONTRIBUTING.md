# Contributing

Use an ordinary user account. The checkout's `.node-version` selects Node major 26; use at least 26.9. The service runtime pin is in `cli/src/services/node-runtime.json`. On macOS install Homebrew Node 26. On Linux use the matching architecture's Node 26 tarball from [nodejs.org](https://nodejs.org/en/download), extract it outside the checkout, and add its `bin` directory to `PATH`. Install sqlite3 (the CLI database backup and release verifier require its binary) and Ruby (release formula syntax tests invoke `/usr/bin/ruby`), install pnpm major 12 and confirm `node --version` and `pnpm --version` before proceeding.

```sh
git clone https://github.com/perintyler/barry-dev.git
cd barry-dev
pnpm install --frozen-lockfile
pnpm build:packages
VITEST_MAX_WORKERS=2 pnpm test
pnpm lint
node --import tsx cli/scripts/verify-install.ts
node --import tsx cli/scripts/verify-nodes.ts
```

The unit command bounds concurrent Vitest workers while retaining every workspace and assertion; it helps keep database and subprocess fixtures reproducible on shared hosts.

ESLint uses the lightweight TypeScript preset. If a local verification process exhausts its heap, retain the failed attempt and resource settings with the report.

Unit tests, lint, package builds and both disposable verifiers run on macOS and Linux without installing services into your real home. The install verifier records service operations without starting launchd jobs; the nodes verifier exercises local disposable nodes. Each prints a report path. See [verify-install](cli/scripts/verify-install.md) and [verify-nodes](cli/scripts/verify-nodes.md) for their scope.

A Mac is required for `cli/scripts/verify-launchd.ts`, the [acceptance lanes](cli/scripts/acceptance/README.md), and a real `barry setup` that starts services. Install channels and data retention are described in the [support policy](docs/support.md). Never run unit tests as root: setup and upgrade intentionally refuse it. The fifteen-minute onboarding target still needs a timed clean-clone run on each platform; report the commands, versions and elapsed time when validating it.

Verification for barry-dev is local. Before a batched push, retain the full CLI suite (`pnpm --dir cli exec vitest run`), both verifier reports, build, lint and static-gate results against the source being reviewed. The vendored checks run without private repository credentials. GitHub workflows are retained for the public mirror; they do not run in perintyler/barry-dev or private repositories. Do not push rehearsal tags or run hosted macOS rehearsals for barry-dev.

## Git history

This repository retains history back to the first commit on January 15, 2026. It is not a one-day snapshot: the October review's contrary limited-history observation is corrected in the review-resolution findings. If `git rev-parse --is-shallow-repository` prints `true`, use `git fetch --unshallow origin` before drawing conclusions from blame, bisect or commit-reference checks. Preserve shared history; merge reviewed PRs with their PR references rather than rewriting old commits.

## Local verification ownership

The ordered tasks in `.github/ci/static-gate.json` define `pnpm ci:verify:static`. The retained public-mirror verifier invokes that same local gate, including spelling, dependency audits and package-consumer checks; documentation-only changes are checked too. Private repository Actions remain disabled.

Use `pnpm -r typecheck` for every workspace rather than the former four-package project graph. ESLint uses the lightweight recommended TypeScript preset, with the repository’s syntax and boundary rules; compiler verification is a separate merge gate. This chooses the review’s documented lightweight alternative instead of paying for a full type-aware program while disabling its unsafe-value family globally. The former additional type-aware lint rules are no longer claimed as checks.

Commit messages are checked in CI against a 72-character subject and accidentally retained editor guidance. Run `node --test .github/ci/checks/commit-message.test.mjs` to check the message policy locally.
