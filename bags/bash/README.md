# Shell tools

Provides Bash, BashOutput and KillShell. Identity tool selection and bounds control access; the `no-bash` bound denies these tools. Packing the bag alone does not impose the bound.

Use Node 26.9 or later and the repository’s frozen pnpm workspace installation. This package is linked within the repository; this documentation does not claim a published SDK or package release.

## Environment variables

Both are read once at module load (`src/executor.ts`) and apply to every `Bash` call:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BASH_OUTPUT_LIMIT` | `51200` (50 KiB) | Max bytes of stdout and of stderr returned per call. Output over the limit is tail-truncated (the end is kept, because that is where the error and summary live) and the result is flagged `output truncated`. |
| `BASH_DEFAULT_TIMEOUT` | `120000` (120 s) | Default per-call timeout in milliseconds when a call does not pass its own `timeout`. A per-call `timeout` still cannot exceed the hard `MAX_TIMEOUT_MS` ceiling of 600000 ms (10 min); on timeout the command is sent SIGTERM, then SIGKILL after 1 s, and the call reports exit code 124. |

See the [operating documentation](../../README.md) for installation and verification.
