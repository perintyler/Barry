# Adapter runtime versions

Barry recommends tested builds without requiring an exact installed version. `barry adapter list` shows each mode's recommendation, tested builds, and supported ranges. `barry doctor` assesses local runtimes. An untested version warns and runs; a documented incompatibility reports its reason and refuses startup. Unknown builds remain unverified.

Recommendations and compatibility belong to each mode. Claude hosted runs its bundled Agent SDK; its interactive modes run the installed Claude CLI. Pi hosted runs its bundled SDK, while model discovery may use the installed Pi CLI. Updating a PATH CLI does not update these bundled dependencies.

These environment variables explicitly select an executable for binary-based operations:

| Adapter | Variable |
| --- | --- |
| Codex | `CODEX_BIN` |
| Claude Code | `CLAUDE_CODE_BIN` |
| Pi CLI operations | `PI_BIN` |
| OpenCode | `OPENCODE_BIN` |
| Antigravity | `ANTIGRAVITY_BIN` |
| Cursor | `CURSOR_AGENT_BIN` |

Set the override in the environment used to launch the operation. Startup and doctor must receive the same PATH/override to inspect the same installation. A configured missing executable is an error. Cursor no longer selects a dated version directory automatically. Vendor auto-update suppression remains enabled where needed to prevent a running session from replacing its executable.

`bux schedule list` includes a local runtime forecast for agent actions. It does not execute the action, inspect credentials, or claim to know a remote worker's executable. The session record is the source for the build actually assessed at launch.

A supported range is a compatibility expectation. Exact entries in `testedVersions` retain the evidence for guarantees such as tool authorization and credential isolation. Only expand these declarations after running the relevant adapter checks; a successful handshake alone does not prove every guarantee. A known-broken build can be excluded with its reason, even inside a supported range.

Legacy registry records remain readable. Ordinary setup refreshes shipped registrations at their existing checkout paths while preserving explicit selections elsewhere. For other packages, re-register using `barry adapter add <package-directory>`; this also restores bundled metadata omitted by older registration code. No `barry adapter verify` command is implied by this change.
