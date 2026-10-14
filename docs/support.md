# Support baseline

This file describes the current implementation. Hosted CI is for the public mirror only; barry-dev uses local build, suites, verifiers, lint and static-gate evidence before batched pushes. Keep the reviewed vendored checks as directed by the handoff; they require no private checkout credentials. Linux x64/arm64 workers are a planned target, with production support gated on #56 phase-1 acceptance. Hardened execution is Linux-only; macOS uses portable. The linked checkout is the primary install channel; the Homebrew release formula remains experimental.

## Platforms

| Platform | Current scope |
| --- | --- |
| macOS arm64 | Installations, release artifacts, launchd services and development |
| Linux x64 and arm64 | Development, unit tests, CI and disposable install/node verification; production worker support is pending |
| macOS x64 | Not in the release channel; system runtime pins include x64, but this is not an installation support guarantee |

## Node

Node major 26, at least 26.9, is required for service handoff with `process.execve`. `cli/src/services/node-runtime.json` is the source of the pinned runtime version; `.node-version`, workspace engines and documentation must agree with its major.

| Channel | Runtime selection |
| --- | --- |
| Linked checkout | Node that runs setup, normally Homebrew Node on macOS; the installed shim pins that executable |
| Release | Node tarball shipped inside the release |
| System services | Root-owned pinned tarball, verified by architecture-specific SHA-256; setup fetches it for a checkout or uses the release copy |

## pnpm

| Setting | Required value |
| --- | --- |
| Major | 12; exact package-manager pin in `package.json` |
| `engine-strict` | `true`; incompatible Node/pnpm versions fail installation |
| `minimum-release-age` | 1440 minutes; new dependency releases wait 24 hours |

Use `pnpm install --frozen-lockfile` for reproducible installs.

## Install channels

| Channel | Current behavior |
| --- | --- |
| Linked checkout (primary) | `barry setup --link .` points `current` at the checkout; development builds belong to the contributor |
| Release | `current` selects an immutable release with its runtime and installed entrypoints |
| Homebrew (experimental) | The keg-only formula installs a release; it is not the primary install channel or a published-tap guarantee |
| System services | Privileged setup stages root-owned code/runtime and proves native modules before swapping; durable service state stays separate |

`barry upgrade` installs the release it runs from and reconciles installed definitions, with an upgrade receipt and rollback snapshot. Running it from a checkout refuses and directs you to `barry setup --link <checkout>`; running a release can upgrade an existing linked installation, recording its previous target for rollback. See [services](../cli/docs/services.md) and [install verification](../cli/scripts/verify-install.md) for the executable guarantees.

Barry's release code is TypeScript/JavaScript executed by Node; this channel does not ship a standalone Barry app for notarization. The bundled Node runtime is nodejs.org's upstream build. Packaging checks its tarball against the pinned SHA-256 and upstream checksum list, and the macOS release check verifies Node's code signature. SHA-256 sidecars and GitHub build-provenance attestations describe the Barry tarball; they do not claim Barry app notarization. Verified by the [release workflow](../.github/workflows/release.yml) and [release check](../cli/src/releases/check.ts).

## Data retention

Paths depend on `BARRY_HOME` and the selected instance. Inspect the dry-run before removing an installation.

<!-- install-footprint:start -->
| Directory or artifact | Uninstall | Purge |
| --- | --- | --- |
| app-support | retained | removed |
| stores | retained | removed |
| cache | removed | removed |
| current | removed | removed |
| releases | removed | removed |
| config | retained | removed |
| logs | retained | removed |
| bin directory | retained | retained |
| LaunchAgents directory | retained | retained |
| Barry shims and registrations | removed | removed |
| Installed app bundles | removed | removed |
| System service state | retained | removed after system daemons are removed |
<!-- install-footprint:end -->

These labels name paths under `BARRY_HOME` (or their default macOS equivalents). Shared `bin` and LaunchAgents parent directories stay; Barry's entries are removed. `current` and `releases` are inside Application Support but uninstall removes those installation artifacts while retaining stores and instance data. System daemon dependencies can require retaining the installation until privileged removal.

System daemons require privileged removal. Application Support is retained while system daemons still depend on it. `--dry-run` reports the footprint without changing it; unattended purge uses `--yes`. The [disposable verifier](../cli/scripts/verify-install.md) proves retention and purge without touching your installed home.

See [linking two machines](workers.md) for owner/worker enrollment and the [verification inventory](verification.md) for evidence boundaries.

## Adapters

At least one session adapter must be installed for `barry start`. Supported shipped integrations are listed in [adapters](../adapters/README.md). Run `barry doctor` to inspect availability and installation problems.

## When something is wrong

Collect these three outputs from the affected instance before changing it:

```sh
barry doctor --json
barry service status --json
barry workers status
```

Include the checkout/release version, Node version, OS/architecture, install channel, failing command and complete error, the affected service/job name, and a disposable-verifier report when available. Keep credentials, invite tokens and application payloads out of issue attachments. `barry workers list --json` adds peer identifiers, scopes and audit observations for a worker problem.

Read a service's output with `barry service logs <name>`. User-service logs are in the instance logs directory, under the bag; the service status reports stdout/stderr files and sizes. Restart rotates nonempty stdout/stderr and keeps three archives. Starting an unloaded job rotates files of at least 10 MiB; `--rotate` requires a stopped service. Running files have no continuous size cap. See the [log contract](../cli/docs/services.md) before scheduling a restart or drain window.

Before a store repair, run `barry db backup` and preserve its printed snapshot path and report. Database backups retain SQLite data; workflow recovery also requires the pinned executable artifacts and explicit old-owner fencing described in the [workflow runbook](../sdk/docs/workflows-runbook.md). Do not treat a binary rollback as permission to restore an older database over a live owner.

Verified by the root doctor/CLI service tests, the [install verifier](../cli/scripts/verify-install.ts), [nodes verifier](../cli/scripts/verify-nodes.ts) and [service acceptance](../cli/scripts/acceptance/README.md). Contact platypus@barry.rocks with this evidence if the checks and runbooks do not resolve the problem.

## Unsupported, and why

| Claim | Why it is not currently certified |
| --- | --- |
| Linux launchd/systemd installation channel | The service adapter is launchd; Linux development supports inert setup but no production systemd lifecycle guarantee |
| Hardened macOS workflow executor | Hardened is Linux-only by policy; macOS uses portable, whose Node permissions do not provide OS network/child isolation |
| Arbitrary SQL schema downgrade | Older code can reject newer stores; use the upgrade receipt and compatible rollback rules |
| Workers you do not operate | Scopes restrict claims but do not verify remote results or provide per-person grants |
| Remote action jobs | The caller grant and pinned prompt authority are not carried to the worker |
| Remote jobs with files or restricted network | The remotable implementation only admits no-file jobs; Node cannot express the full network bounds |
| Exactly-once physical external effects | A retry or uncertain result can repeat a call; the destination must atomically deduplicate a logical effect key |
| A short probe as soak certification | Production acceptance requires the retained one-hour/overnight workload receipts and fault/recovery evidence |
| Automatic cross-machine old-owner fencing | Restoring a database epoch does not revoke the old machine's network or effect authority |

Verified by the explicit limits in [verification](verification.md) and the [workflow runbook](../sdk/docs/workflows-runbook.md).
