# Service management

A service is an independently managed program: an API, MCP server, GUI app, or daemon. Barry prepares its command and environment; launchd runs, restarts, and stops its process. Service control belongs to the `mcp` bag. The CLI installs its subject and reaches launchd in-process, so it can restart `mcp.server` even when the server is down.

An instance has a durable UUID in `instance.json`, prepared definitions, port assignments, and `services.json` user choices. Labels include the instance ID. Removal leaves a durable unregistered choice, so setup and reconciliation cannot recreate a service the user removed.

The service layer is one `ServiceOS` interface — the five operations in `bags/mcp/src/services/launchd.ts` (`inspect`, `load`, `unload`, `enable`, `start`) — and every backend (launchd today, the inert OS where launchd is absent, a future systemd OS) implements exactly that one interface rather than forking it.

| Command | Registration/policy | Current process |
| --- | --- | --- |
| `barry service list` / `status` | Read declarations and choices | Inspect launchd; health is reported independently |
| `add <name>` | Register disabled unless already enabled | Do not start |
| `enable <name>` | Enable next login/boot launch | Do not start unless `--now` |
| `disable <name>` | Disable next login/boot launch | Keep running unless `--now` |
| `start <name>` | Preserve enabled/disabled choice | Explicitly start |
| `stop <name>` | Preserve choice | Boot out; prevent immediate keep-alive restart |
| `restart <name>` | Preserve choice | Stop completely, then start |
| `remove <name>` | Unregister and preserve removal choice | Stop; retain software and data |
| `run <name>` | Preserve choice | Foreground execution with prepared environment |
| `logs <name>` | Preserve choice | Read launchd's output files |
| `barry up` / `down` | Preserve choices | Finite start of enabled registrations / stop of registered services |

`stop` lasts until an explicit start or the next OS login/boot trigger for an enabled registration. `disable` is the persistent way to suppress those triggers. A manual start temporarily permits execution and restores the persisted launchd policy afterward.

The service entry resolves only declared environment values, then uses Node's `process.execve` to replace itself. launchd therefore owns the service PID directly. Node 26.9 or newer is required. Workflow services retain their application-specific graceful drain; OS registrations allow 40 seconds before forced termination. Session-owned detached processes and computation children keep their existing owners.

User services and apps use `gui/<uid>`; daemons declaring a separate user use `system` with `UserName`. Installing or modifying a system daemon requires the OS permissions to write `/Library/LaunchDaemons` and manage the system domain. Run management under an authorized administrative context while preserving the intended instance configuration. Permission failures leave an incomplete operation in the ownership record and can be retried.

Setup prepares directories, credentials, CLI shims, bundles, and app installations, then uses the same service operations. It preserves disabled and removed choices. `--no-start` prepares registrations without activation.

The isolated verification script creates a unique temporary fixture job and removes it in `finally`:

```sh
node --import tsx cli/scripts/verify-launchd.ts
```

It verifies add/enable without activation, manual start while disabled, policy-only disable, disable-now, stop without immediate restart and removal. Actual login/reboot behavior requires a dedicated operational rehearsal; the script does not log out the user or change production jobs.

## System services

Run `barry setup` as the owner to prepare declarations, then `sudo barry setup --system --dry-run` to review the privileged actions. `sudo barry setup --system` installs accounts and root-owned built code, starts the instance's LaunchDaemons, and verifies health before retiring the legacy daemon. Failure restores the previous daemon or code. The previous code remains in the code directory's `.previous` sibling.

System control requires sudo: `sudo barry service restart vault.api`. Ordinary setup, refresh, `up` and `down` leave system services alone. An explicit system setup installs removed system services again.

System services run a root-owned Node, never the user's. `cli/src/services/node-runtime.json` pins nodejs.org's macOS tarball and its SHA-256 per architecture. The pinned major must match the workspace's Node, because native modules are built against it; a test enforces this. `barry setup` uses the release's shipped tarball, or downloads it into the owner's cache in a checkout, when the runtime is not installed. The system pass has no network. It refuses a missing or mismatched tarball, extracts it root-owned and read-only, and loads the staged code's native modules with it as the service account before the switch. It swaps the runtime in with the code and keeps one `.previous`.

Port changes retain an operation receipt so retry can restart a service that was running before an interrupted change. Service status exposes incomplete operations.

Logs use launchd's stdout/stderr files. Reading tails is bounded; `logs <name> --rotate` rotates only a stopped service and keeps three archives. Every restart rotates nonempty stdout and stderr files, keeping the last three runs and preserving file permissions and ownership. Starting an unloaded job still rotates only logs of at least 10 MiB. Files can grow while a service runs continuously. After its services step, setup collects logs of undefined services only when no job is loaded and the file is at least 24 hours old. It prints the removed keys and total bytes; unrelated names and subdirectories are kept.

## Selecting services

`start`, `stop` and `restart` require service keys, bag names, or explicit `all`.
A bare command is refused. `all` excludes system, disabled and unregistered
services: start selects those not running, stop selects those running, and
restart selects those running except apps. The CLI prints the expansion first,
acts in key order and puts `mcp.server` last. `restart --dry-run` only prints.
`restart all` waits up to 60 seconds for each service's process and health before
continuing; a failure stops the sequence and names the services left untouched.

The MCP bag offers deferred `services_list`, `services_status` and
`services_restart` tools. The `mcp:services` trait grants restart access; a
read-only bound removes it. A session acting for a bag may control that bag's
own services. Devices are refused. A process cannot restart itself; use the
CLI to restart `mcp.server`. Restarting `sessions.api` ends running turns.

Other processes reach service control over HTTP on `mcp.server`, through Barry’s separate `services` connection option. Start, stop and restart on Barry remain local when the CLI hosts the subject.
