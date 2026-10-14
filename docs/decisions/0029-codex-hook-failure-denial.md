# ADR 0029: Codex hook failure denial

Status: implemented on Step 15; final gates and other vendor/mode checks pending.

## Evidence

On pinned Codex 0.160.1, three real hosted-engine regressions forced a granted
native file write after deleting its gate script, replacing it with a throw, or
replacing it with a nonterminating script. Every write executed before this fix.
The existing positive control separately verifies an ordinary granted write runs.
The model and MCP endpoints in these checks are local fixtures with synthetic keys.

## Decision

The configured hook invokes a private launcher, which runs the policy script in a
child process. Missing scripts, nonzero exit, timeout, excess output, invalid JSON
and unrecognized decisions produce an explicit Codex deny response. A successful
empty policy response retains Codex's existing allow convention. Valid policy
denials pass through. Error details from the child are not forwarded to the vendor.

The launcher's timeout is eight seconds, inside the vendor hook's ten-second
deadline. It uses the same absolute Node executable as the configured hook and
inherits no shell interpolation. The shared private writer creates/restricts all
three generated hook files to 0600 in the owned 0700 home.

## Limits and verification

After the fix, all three failure cases refuse the forced write and the normal
native-grant control still passes. Four additional actual-child unit probes cover
missing scripts, throws, invalid JSON and unsupported decision shapes. Types and
focused lint pass separately.

This makes policy-script failure deny while the launcher works. It does not change
Codex's vendor-wide hook-error behavior: deleting the launcher, losing its Node
executable, disabling hooks, or exceeding the outer deadline can still permit a
call. These are best-effort guards rather than an adversarial sandbox. Scheduling
starvation can consume the timeout margin. The failure injections here exercised
hosted execution; guest/instrumented UI and other-vendor acceptance remain open.
