# SDK and installation acceptance

See the [verification inventory](../../../docs/verification.md) for coverage, platforms, receipts and the limits of each lane.

Run from a clean retained Barry checkout with its frozen dependencies installed.
Use Node 26.9 or newer (the service handoff needs `process.execve`). The drivers
use synthetic data and loopback listeners; none deliver provider or notification
effects. Each OS driver requires a new absolute fixture directory and retains a
protected receipt. Ordinary CI runs the shared fixture as part of the SDK suite.

```sh
# Use the Node that .node-version names (26.9 or newer).
export LC_ALL=C LANG=C
pnpm install --frozen-lockfile
pnpm --dir cli exec vitest run test/acceptance/identity-bounds.test.ts
pnpm --dir sdk exec vitest run --maxWorkers=2
node --import tsx cli/scripts/acceptance/verify-services.ts run /private/tmp/barry-acceptance-services
node --import tsx cli/scripts/acceptance/verify-app.ts /private/tmp/barry-acceptance-app
node --import tsx cli/scripts/acceptance/verify-workflow-drain.ts /private/tmp/barry-acceptance-workflow
pnpm --dir bags/workflows exec playwright test
```

Choose different new output directories for repeated runs. The service lane
checks direct PID ownership, crash restart, disabled manual start, policy-only
enable/disable, bounded graceful stop, instance isolation, foreground/background
conflicts, and logs. The app lane compiles and runs a real AppKit application.
The workflow lane starts the actual workflow service with a noncooperative child,
checks every captured PID/start identity has exited, and reopens durable state.

If interrupted, `verify-services.ts cleanup <root>` recovers that lane.
Other OS lanes write `cleanup.json` before mutation; run
`cleanup-fixture.ts <root>` to unload only their recorded instance/jobs. It
retains legacy plist bytes for inspection with automatic launch disabled.
Administrative fixtures need an administrative cleanup process. Cleanup does
not remove user accounts or recovery archives. Receipts and fixture roots stay
outside Git.

## Actual login and reboot

Use a designated disposable macOS GUI account/VM. Keep the checkout, Node and
fixture root on persistent storage, outside temporary directories. Preparation
installs only unique fixture-instance labels in that account's LaunchAgents.

```sh
node --import tsx cli/scripts/acceptance/verify-services.ts prepare-triggers /Users/Shared/barry-trigger-acceptance
# Log out and back into the disposable account.
node --import tsx cli/scripts/acceptance/verify-services.ts resume-triggers /Users/Shared/barry-trigger-acceptance login
# Reboot, then log into the disposable account.
node --import tsx cli/scripts/acceptance/verify-services.ts resume-triggers /Users/Shared/barry-trigger-acceptance boot
```

The driver refuses unchanged GUI security-session identity or kernel boot time.
It observes readiness of enabled and stopped-but-enabled jobs and absence of
disabled/removed jobs; a kickstart cannot satisfy these gates. Final resume
removes fixture registrations. `cleanup` is available before either trigger.

## Log contract

Running stdout/stderr files have no continuous size cap. `barry service list`
reports when rotation is recommended; JSON list/status report both byte counts.
At 10 MiB, schedule a service restart in an appropriate drain window. Barry
unloads the job before rotating and keeps three archives per stream. Bounded
tail reads use at most 1 MiB per current/prior file. Inspect sizes daily and
before unattended operation; reserve disk for workload growth and recovery.
Do not rename or copy-truncate a live file: launchd retains its output
descriptors. This contract adds no persistent logging supervisor.

## Compatibility, inventory and long-duration release gates

```sh
node --import tsx cli/scripts/acceptance/inventory-installation.ts '/absolute/Barry/app-support' /absolute/new-recovery-bundle
node --import tsx cli/scripts/acceptance/verify-compatibility.ts /absolute/recovery-checkout /absolute/candidate-checkout /absolute/recovery-bundle/inventory.json /absolute/new-compatibility-output
node --import tsx cli/scripts/acceptance/verify-load.ts one-hour /absolute/new-hour-output
node --import tsx cli/scripts/acceptance/verify-load.ts overnight /absolute/new-overnight-output
```

Inventory is read-only against the installation and writes protected archives.
It backs up SQLite through its snapshot API, including archived stores, so size
can be substantial. Each database snapshot is independently consistent; a
cross-store recovery point still requires a quiesced final snapshot. It records
environment names and process identities without arbitrary process arguments.
Protected system registrations require administrative reads and appear as
explicit inventory problems when unavailable.

Compatibility requires unchanged SQL catalogs and opens snapshot copies with
retained → candidate → retained binaries. It records row counts and integrity,
without displaying data. Its identities/session samples complement migration
tests; they do not certify every external bag's schema or artifact ABI.

Load lanes require a clean committed checkout and run for 3,600 and 28,800
seconds respectively. They retain revision, source digest, workload, latency,
memory, database growth, failure counts and cleanup evidence. The workload is
two in-process v2 owners, two workers with four slots each, 16 open runs per
owner and 1 KiB inputs, using real isolated computation children. It does not
certify WAN partitions or unsupported production loads. Early termination,
changed source, failures, absent completions or failed latency limits cannot
pass. A short probe cannot substitute for either lane.

`start-load.ts <absolute-new-persistent-output>` runs those lanes sequentially
in a detached process, starting overnight only after the hour passes. Inspect
`lane.json`, `lane.log` and the per-lane receipts. The checkout must remain
unchanged throughout. Starting it is pending evidence until both lanes pass.

For separate owner/worker HTTP services, select the network mode:

```sh
node --import tsx cli/scripts/acceptance/start-load.ts --network /absolute/new-persistent-network-output
```

The default in-process mode remains unchanged. Network mode runs a 3,600-second
measurement followed by a 28,800-second measurement, with one owner, one worker,
four worker slots, 16 open runs and 1 KiB inputs. Each lane adds a ten-second
warmup and a separate thirty-second baseline before its requested measurement;
these windows do not shorten the requested hour or overnight duration. Startup
and drain add further time. The detached wrapper preserves `TMPDIR`, freezes
the parent's revision and requires that same clean checkout before each lane
and before recording overall success. A failed hour prevents overnight startup.

Read and heartbeat p99 limits are baseline × 1.25 + 5 ms, capped at 1,000 ms:
half the workload's actual 2,000 ms heartbeat timeout. A slow baseline cannot
raise the cap. Calibration requires at least 100 read and heartbeat samples in
each window, unchanged executable digests and complete window durations.
Inspect the schema-2 `report.json`, `baseline.json` and baseline/measurement
metrics in each lane's output. Zero errors, completed work drained and confirmed
owner/worker process cleanup are mandatory; failed, interrupted or unfinished
receipts are not passing acceptance.

Latency arrays retain the last 20,000 observations of each kind. Long-run p99
therefore describes that retained tail, rather than every latency across the
whole lane. Work/error counters and post-warmup memory samples cover the full
measurement. Preserve raw metrics and this limitation when comparing receipts.

Retain completed schema-2 receipts and run the historical comparison separately:

```sh
node .github/ci/checks/soak-trend.mjs /absolute/new-persistent-network-output/one-hour/report.json /absolute/hour-history
node .github/ci/checks/soak-trend.mjs /absolute/new-persistent-network-output/overnight/report.json /absolute/overnight-history
```

The trend check validates receipt structure and same-run calibration, then
compares up to five matching platform, hardware, Node, duration, complete
workload and calibration-policy receipts. Schema-2 comparisons include the
baseline read/heartbeat timings as well as measurement timings and memory
slopes, preventing a busier baseline from silently ratcheting the limit. Legacy
fixed-limit receipts do not substitute for calibrated history. A first receipt
establishes history without certifying a historical trend. Where the plan calls
for three overnight runs, retain three actual completed nights; this wrapper
schedules one overnight lane and does not manufacture the other receipts.

## Additional manual verification

The isolated lifecycle can also be run on macOS with:

```sh
node --import tsx cli/scripts/verify-launchd.ts
```

Production-store verification reads a source installation and backs it up into
scratch before migrating copies. Run it manually against an explicit source:

```sh
node --import tsx cli/scripts/verify-production-stores.ts /absolute/source/app-support
node --import tsx cli/scripts/acceptance/cleanup-fixture.ts /absolute/owned-fixture
node --import tsx cli/scripts/acceptance/start-load.ts /absolute/new-persistent-output
```

The install lane's macOS job runs isolated launchd and service acceptance on tags,
weekly, and on dispatch. Login and reboot remain manual with retained receipts;
a hosted job does not simulate them.

The install verifier invokes [verify-install-release.ts](../verify-install-release.ts)
in a child process with a scratch fixture root. Its runtime and service ledgers
are test fixtures; real tarball acceptance runs in the macOS release lane.

To run that fixture directly from the checkout:

```sh
node --import tsx cli/scripts/verify-install-release.ts "$PWD"
```

## Actual release upgrade matrix

Use real darwin-arm64 release tarballs on a non-root Mac; runtime stubs and renamed candidate copies do not count as a previous release:

```sh
node --import tsx cli/scripts/verify-release-upgrade.ts --candidate /absolute/candidate.tar.gz --previous /absolute/previous.tar.gz --output /absolute/new-release-matrix
```

The driver uses the first artifact's own `verify-nodes.ts --seed` migration/row-ownership fixtures and installs into a private HOME/BARRY_HOME, leaves user services disabled, prepares a store generation through CLI backup/restore, seeds retained fixture data in each store, upgrades using the actual candidate executable and rolls back using the installed executable. It records strict doctor output, complete upgrade/rollback receipts, integrity, all-table row counts/content hashes, file digests and SQLite snapshots. It removes the isolated installation at the end; receipts, initial backup and stage snapshots remain outside it.

Previous artifacts require their published `<tarball>.sha256` sidecar; any candidate sidecar present is also verified. With no `--previous`, the candidate bootstrap records `previousEvidence: false` and pending upgrade/rollback evidence. User services are deliberately disabled, so `healthCertified` remains `false` even if strict doctor passes. Named strict-doctor system failures remain explicit in the receipt. A passing data matrix does not imply privileged service acceptance. Attach the matrix receipt and snapshots alongside the separate macOS system-service acceptance evidence.

Store evidence retains raw file and table hashes alongside logical comparison hashes. Every store and value is compared exactly under an unchanged migration registry. A changed registry still requires every retained table and its prior row count; incompatible transformations need an explicit reviewed mapping before certification.

### Privileged artifact health gate

Public mirror release publishing requires a separate same-run privileged health job after the immutable artifact build. The data matrix keeps `healthCertified: false`. The producer remains unexercised: no privileged certificate exists yet. Hosted workflows are optional mirror infrastructure; barry-dev uses local verification and does not create rehearsal tags or dispatch hosted jobs.

Provision a dedicated macOS arm64 runner labelled `barry-release-system`, protect its `release-system` environment, and enable `BARRY_RELEASE_SYSTEM_ENABLED` only after provisioning. The owner must have noninteractive sudo, an existing system service account (currently `_barryvault`) and active membership in its group. `/usr/local/libexec` and `/usr/local/var` must already be root protected. The producer refuses legacy daemons and existing fixture paths; it does not modify shared accounts, memberships or parent permissions. Do not run this producer on a personal installation.

The job downloads the exact same-run release bundle, runs owner setup and the supported privileged `setup --system`, explicitly enables every declared service, requires their running PIDs and declared health endpoints, and requires strict doctor exit zero. It verifies system code and runtime match the artifact and have root-protected ancestors. It removes owner jobs before the privileged instance purge and requires every owned label, plist and system path to be absent. A failed or interrupted cleanup cannot certify health. SIGKILL or machine loss requires manual recovery of that recorded fixture; the cleanup handler is not crash recovery. The receipt binds source SHA, tarball SHA-256, run ID and attempt. The publish job independently validates that receipt; disabled, missing or failed health jobs block public releases. Rehearsal tags remain draft-only without a privileged certificate.
