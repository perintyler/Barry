# CI launcher and policy

A fresh clone runs unit suites, static policy, and audits without private repository
credentials. `run.mjs` uses repository-specific checks in `checks/` and generic
checks in `vendor/checks/`. Keep the reviewed vendored checks as directed by
the owner handoff. `vendor/UPSTREAM.json` records the upstream revision. Only
used generic tasks are retained; migration vocabulary scanners exclude their own
source by resolved filename because their examples deliberately name old tokens.

An explicit upstream override is still available for developing generic checks:

```sh
BARRY_DEVOPS_DIR=/absolute/barry-devops pnpm check:monorepo
```

No task silently skips when an override is absent or invalid. Local and hosted
runs use the same checked-in implementation; setup needs no deploy key. The old
`devops.json` records historical provenance and does not trigger a network fetch.

## Review and checks

`CODEOWNERS` requests owner review for installation, release, and distributed
execution changes. The pull request template requires verification evidence,
including retained receipts for manual acceptance. Workflow actions use full
commit SHAs, top-level permissions default to read, and Dependabot opens pin
updates weekly. Local reusable actions/workflows resolve within the checked-out
commit and do not use external pins.

## Local pre-push gate and public mirrors

The owner's 2026-10-09 policy makes local verification authoritative in
`perintyler/barry-dev`. Repository Actions were disabled on 2026-10-09 and the
disabled setting was confirmed; branch protection was not changed. The guards
below also protect the checked-in workflows if that setting changes. Retain
exact-source results before pushing a batch:

```sh
pnpm install --frozen-lockfile
pnpm build:packages
pnpm lint
pnpm ci:verify:static
pnpm test
node --import tsx cli/scripts/verify-install.ts
node --import tsx cli/scripts/verify-nodes.ts
```

Run as a non-root user with the supported toolchain, `sqlite3`, OpenSSL and the
security scanner available. Keep the printed verifier reports and command totals.
A missing prerequisite or a targeted follow-up does not certify an incomplete
full gate. No required hosted checks, branch-protection update or five-green-push
sequence is needed here. CODEOWNERS and the PR template retain the review/evidence
contract; vendoring has landed through PR #57 and is verified by review Step 16.

All jobs, including reusable callers and release/cut/soak jobs, require
`github.repository != 'perintyler/barry-dev' && github.event.repository.private == false`.
Development and private-fork jobs skip before allocating a runner. Public mirror
operators retain existing event/schedule/feature-variable controls, exact-commit
acceptance, release provenance and privileged-health requirements. The security
check rejects an absent or bypassable repository guard; install coverage still
requires both verifiers without conditional steps or swallowed failures.

Do not push tags or dispatch Actions from barry-dev. Mirror release timing,
runner provisioning and repository settings are separate operator work.

## Flakes

There are no automatic retries. Quarantine requires a commit linking a GitHub
issue, naming an owner, and adding `{ test, owner, issue, since }` to
`quarantine.json`. `workflow-security.mjs` rejects malformed entries and entries
older than thirty days. The current list is empty. Adding an entry does not skip
a test: any explicit test skip must be reviewed in that same commit.

## Verification

`pnpm check:workflow-security`, `pnpm check:workflow-triggers`,
`pnpm check:node-version`, `pnpm check:stale-paths`, and `pnpm check:doc-links`
run in the local static gate and retained mirror CI. The unit runner discovers suites from workspace manifests and
fails an empty scope. No-orphan verification checks every verify/acceptance
script against workflows and the acceptance runbook.

## Tracked instruction text

`pnpm check:prompt-instructions` rejects instruction-bearing HTML role comments and stop-work payloads in tracked text. It runs with its negative controls in the local static gate. Historical review evidence must link to the original revision instead of repeating the payload in live documents. License permissions are unchanged by this check.
