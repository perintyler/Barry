# Installing Barry

Use the versions and platform scope in [support](support.md). Real service startup requires macOS launchd. Linux development uses disposable verification or `setup --no-start`; it does not acquire a systemd service implementation.

## Linked checkout

The linked checkout is the primary install channel. Run as the instance owner, using Node 26.9 or newer and pnpm 12:

```sh
git clone https://github.com/perintyler/barry-dev.git
cd barry-dev
pnpm install --frozen-lockfile
pnpm build:packages
node cli/bin/barry.js setup --link .
```

Setup selects the checkout as `current`, pins the Node executable in the shim, provisions the owner, seeds shipped bags and synchronizes missing bounds without overwriting existing tuning. Changing checkout code requires rebuilding packages. Running `barry upgrade` from checkout code refuses; use setup to reconcile this channel.

Setup prints the installed command's full path. Its directory must be on `PATH` before running the `barry` commands below; keep the same addition in your shell configuration. With a custom `BARRY_HOME`, use:

```sh
export PATH="$BARRY_HOME/bin:$PATH"
barry --version
```

Without `BARRY_HOME`, setup chooses the first writable directory from `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`. Add the directory printed by setup if it is absent from `PATH`; for the last location, use `export PATH="$HOME/.local/bin:$PATH"`.

For development without starting services, add `--no-start`. Setup writes definitions and registrations; a running-service health check will report stopped services. Linux startup reports an unsupported-service refusal after writing the installation artifacts.

Verified by [verify-install.ts](../cli/scripts/verify-install.ts), setup and installed-paths unit tests, and the `install / disposable` lane. Actual service startup is checked by the macOS lane.

## Release

The linked checkout is the primary install channel. Homebrew releases remain experimental: the committed keg-only formula is not a published-tap guarantee. Use a verified darwin-arm64 release artifact when one has been supplied; its runtime and entrypoints travel together.

From its extracted directory, run:

```sh
./bin/barry setup
barry doctor --json
barry service status --json
```

After setup, add the printed command directory to `PATH` as described under [linked checkout](#linked-checkout) before running the bare `barry` commands.

To upgrade, invoke `bin/barry upgrade --yes` from the new release directory. It installs the release it runs from; it does not fetch an unspecified latest release. The upgrade journals its switch and store snapshot. `barry upgrade --rollback --yes` returns to the recorded previous installation when schema checks permit it; preserve the snapshot named by a refusal and inspect it before repairing state.

An experimental Homebrew installation requires the keg's own `bin/barry` for initial setup and each upgrade, as printed by `brew info barry`; bare `barry` may still select the linked checkout or the previous installed release. The new release's entrypoint must run the upgrade.

Verified by release/upgrade unit tests and [release-check.ts](../cli/scripts/release-check.ts); publishing, signing and notarization require their own release evidence.

## System services

First run ordinary setup as the owner so the code, runtime tarball and instance registrations exist. Then inspect and apply the privileged pass:

```sh
barry setup
sudo "$(command -v barry)" setup --system --dry-run
sudo "$(command -v barry)" setup --system
```

If ordinary setup used a custom `BARRY_HOME`, sudo must receive that same absolute path. Replace the two privileged commands above with:

```sh
sudo env BARRY_HOME="$BARRY_HOME" "$(command -v barry)" setup --system --dry-run
sudo env BARRY_HOME="$BARRY_HOME" "$(command -v barry)" setup --system
```

Keep `BARRY_HOME` set to that instance when running later owner commands. A different or missing value selects a different installation.

The privileged pass installs root-owned code and a pinned, digest-verified Node runtime. Each service runs as the account declared by its service specification; inspect the dry-run for the concrete account and paths. Setup prepares the runtime from the shipped release or downloads the checkout pin before elevation. The system pass has no network and refuses absent or mismatched bytes. It proves native modules before switching code/runtime and keeps a previous copy. Durable service state is separate from executable code.

Verified by system-service unit tests and the manual administrative [acceptance lane](../cli/scripts/acceptance/README.md). Linux does not support this launchd installation channel.

## Footprint and verification

Without `BARRY_HOME`, the instance uses the macOS paths below. With it, all instance state is rooted there; default paths still use the macOS layout on a Linux development host. Some directories are created only when their feature is used.

| Location | Contents |
| --- | --- |
| `~/Library/Application Support/Barry` or `$BARRY_HOME/app-support` | Instance record, config database, bag/resource/provider/service registries, private `env`, stores, archives, backups, release directories and `current` selector |
| `~/Library/Caches/Barry` or `$BARRY_HOME/cache` | Regenerable builds and fetched runtime artifacts |
| `~/Library/Logs/Barry` or `$BARRY_HOME/logs` | Bag/service stdout and stderr, with rotated archives |
| `~/.config/barry` or `$BARRY_HOME/config` | Configuration |
| Instance CLI bin directory | Executable Barry and identity shims |
| Owner's `~/Library/LaunchAgents` | Instance-labelled user service registrations |
| System service paths from dry-run | Privileged code/runtime, daemon registrations and separate durable state |

```sh
barry doctor --json
barry service status --json
barry service list
barry workers status
```

`doctor --strict` exits unsuccessfully for installation failures. A service intentionally left stopped by `--no-start` can fail the running-service check. Adapter availability and installation health are distinct observations in the report.

`barry service status --json` also exits unsuccessfully when a service needs attention, such as missing system setup; its JSON explains each service's state. A named service check also fails when that service is stopped. After `setup --no-start`, use `doctor --strict` to check enabled services that have not started; the unfiltered status command alone does not certify running-service health.

Verified by the [disposable install verifier](../cli/scripts/verify-install.md), which asserts registry files, private env permissions, selector, shim, bounds, doctor output, idempotence and removal. See [verification](verification.md) for the real OS checks and their limits.

## Removing an installation

```sh
barry setup --uninstall --dry-run
barry setup --uninstall
```

The second command removes registrations, shims, caches and removable installation files while keeping durable data. `barry setup --uninstall --purge --yes` removes the retained data too. System daemons require privileged system removal before their dependent data can be purged. The [retention table](support.md#data-retention) lists exceptions.

Verified by the disposable install verifier and uninstall tests.

## Troubleshooting

| Symptom | Next action |
| --- | --- |
| Setup requires the instance owner | Run ordinary setup as that user; elevate only the system pass |
| Services need launchd / unsupported service operation | Use macOS for running services; use `--no-start` for Linux development and disposable checks |
| `current` points to a missing target | Restore the recorded checkout/release or run setup with an existing target; inspect doctor before changing data |
| Unknown bound / suggestion to sync traits | Run `barry bag sync-traits <bag>` and inspect `barry workers status`; preserve existing tuning |
| No shipped runtime or `BARRY_NODE` | Use the release's entrypoint or rerun linked setup with the supported Node on PATH |
| A label such as `model=local` is missing | Set `BARRY_WORKFLOW_LABELS` in the workflows service environment only on a worker that actually has that capability |

For a failure report, follow the [support playbook](support.md#when-something-is-wrong).
