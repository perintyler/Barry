# Barry CLI

The CLI creates identities, installs and grants capability bags, starts vendor-backed sessions, and manages the local instance’s services. Commands use the selected identity and its configured credentials.

## Install

Follow the [installation guide](../docs/install.md). For a source checkout, install the pinned Node and pnpm versions, run `pnpm install --frozen-lockfile`, then `pnpm build:packages`. Run `barry setup` as the instance owner and `barry doctor` to inspect the installation.

Set `BARRY_HOME` for a separate contributor instance; use `BARRY_NODE` only when selecting an explicit compatible runtime. Secrets and identity bindings belong to that instance, rather than a shared shell environment.

## Command groups

The following is the root `--help` output from a clean contributor fixture. Bag-contributed commands appear after registry setup.

```text
Usage: barry [options] [command]

Barry - personal AI coding agent CLI

Options:
  -V, --version                       output the version number
  -i, --identity <identity>           The identity to act as
  -h, --help                          display help for command

Your setup:
  identity                            Create and configure identities
  ls [args...]                        List all identities (alias for `identity
                                      list`)
  doctor [options]                    Report installation health, adapters and
                                      identity configuration drift
  use|switch [options] [name]         Use an identity (interactive picker if no
                                      name given)
  alias [options] [identity] [alias]  Give an identity another command name
                                      (e.g. `bgo` for bgoode)
  config                              Barry configuration (show, export,
                                      import)

Capabilities:
  bag                                 Manage capability bags
  adapter                             Agent adapters — which are usable on this
                                      machine
  install [options] <target>          Install a bag on this machine and
                                      register it (local dir, npm package, git
                                      repo, or MCP URL). Repos are cloned to
                                      ~/repos/bags. Pack it onto an identity
                                      with `<identity> pack <bag>`.
  new [options] <kindOrName> [name]   Scaffold a bag, action, instruction, or
                                      trait (bare name = bag)
  trait                               Manage traits
  bound                               Manage bounds
  app                                 See and open this instance's registered
                                      GUI apps
  schedule                            See, run and pause schedules (actions on
                                      a trigger)
  cursor                              Cursor agent integration
  completion                          Output shell completion script (eval
                                      "$(barry completion)")

This machine:
  workers                             Machines that run this Barry's workflow
                                      activities, and the owners this machine
                                      works for
  device                              Review pairing requests and manage scoped
                                      device credentials
  down                                Stop registered services without changing
                                      automatic startup
  up                                  Start registered enabled services through
                                      launchd
  setup [options]                     Install this instance: its CLI, apps,
                                      configuration, and declared service
                                      registrations
  owner [options] [actor-id]          Show or bind the local installation's
                                      user owner
  uninstall [options]                 Uninstall Barry: stop services, remove
                                      launchd agents, and delete shims
  upgrade [options]                   Move this instance onto the release this
                                      barry belongs to: snapshot, migrate a
                                      copy of the stores when their schemas
                                      change, switch, restart and verify
  status [options]                    Show operational status of services,
                                      stores, and schedules
  store                               Inspect and verify Barry stores (SQLite
                                      databases)
  service                             See and control this instance's services
  hosting                             What this instance exposes, where, and
                                      whether it is applied
  env                                 This instance's secrets file
  db                                  Back up, restore, roll back, recover or
                                      prune the stores this instance runs on
  devops                              Tyler's-machine operations (ios, redmark)

Files:
  trash [files...]                    Soft-delete files by moving them to this
                                      instance's trash
  archive [options] [files...]        Move files to this instance's archive

  help [command]                      display help for command

Identity Personas:
  Barry operates through identity personas. Run sessions under an identity:
    <identity> session start       (e.g. `bux session start`)
    barry --identity <name> ...    (explicit identity bridge)
  Run `barry identity list` to see installed identities.
```

Run `barry <command> --help` for flags and subcommands. See [service management](docs/services.md) for registration, startup policy and process control, and [verification](../docs/verification.md) for local checks.

At root, `barry schedule` permits read-only listing of maintenance schedules. Select an identity for schedule run, pause, resume and history operations.
