Run `node --import tsx cli/scripts/verify-install.ts [checkout]` from the repository root as an ordinary user, with dependencies installed, the packages built (`pnpm build:packages`) and Node 26. It runs on Linux and macOS.

The script installs the checkout the way the README tells a new user to (`barry setup --link .`) into a disposable `HOME` and `BARRY_HOME`, with a recording stand-in for launchd that accepts policy (enable/disable) and refuses to load or start anything, which is what `--no-start` promises. Installed Barry homes, launchd jobs and vaults are never touched. It checks:

- `--link` refuses a directory without `identity.yaml`, and refuses to combine with `--uninstall`, without pointing `current` anywhere;
- a first setup points `current` at the checkout, provisions the owner, seeds every shipped bag, selects the shipped call-code packages, writes the instance record and service definitions, declares the core services (`mcp.server`, `sessions.api`, `workflows.runtime`, `schedules.scheduler`, `vault.api`), writes a private `env`, writes launchd registrations carrying this instance's id, and installs a `barry` shim that pins the Node that ran setup;
- the installed shim works with nothing else on `PATH`: `barry --version`, `barry workers list --json`, `barry bag list`, `barry workers status`;
- setup syncs the shipped remotable job’s bounds: `sessions:summarize-session@1` immediately reports its missing `model=local` label; repeating `sync-traits` changes nothing;
- `doctor --json --strict` reports install checks after setup and uninstall; enabled services deliberately left stopped fail strict health;
- the inert service host accepts registrations with `--no-start` and refuses startup with one named unsupported error;
- fresh release setup, linked-checkout upgrade, release-to-release upgrade and rollback preserve store file digests and write complete receipts; macOS uses the verified pinned runtime tarball, Linux uses a host-runtime fixture; the source location and service OS are injected while staging, selector and shim writes, snapshots and receipts use production code; package dependency trees are linked to the built checkout and package rebuilding is covered by its separate lane;
- a second setup is idempotent: same instance id, same registrations, same shim, policy calls only;
- `setup --uninstall --dry-run` names the registrations and shim and removes nothing;
- `setup --uninstall` removes them and keeps the data; `--purge` removes the data too; and setup after a purge starts a fresh instance.

Each run prints the location of a JSON report with per-scenario details. What it cannot prove is that launchd loads, restarts and stops the jobs: that is `cli/scripts/verify-launchd.ts` and the OS lanes in [`cli/scripts/acceptance/`](acceptance/README.md), on macOS. The multi-machine side (invite, join, remote jobs, revoke) is [`verify-nodes.ts`](verify-nodes.md). The `install` workflow runs both on every change to the CLI, the SDK or the bags.
