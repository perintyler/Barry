# ADR 0030: Cursor hook schema

Status: implemented; pinned live failure verification remains pending.

The [official hooks schema](https://cursor.com/docs/hooks) documents permission
allow/deny responses for preToolUse and beforeMCPExecution, and failClosed to
block hook crashes, timeouts, nonzero exits and absent output. Keep failClosed
with a source comment; emit an explicit allow instead of an empty object.

Two actual generated-script regressions failed before the output change. Twelve
gate/workspace assertions now pass. Existing denial, native-grant and installed
Node controls now require the explicit response. Adapter types and focused lint
pass. This is schema and generated-script evidence, not a real Cursor model turn.
The installed build is in the pinned calendar family, but no dedicated test
credential is supplied; live error/timeout/missing-script checks remain open.

## Original header

```text
/**
 * Barry's gate in cursor's TUI, run for `preToolUse` and `beforeMCPExecution`.
 *
 * `preToolUse` names an MCP call only as `MCP:<tool>`, without its server, so
 * there it lets MCP calls on and refuses everything else; the server and
 * Barry's denials are checked at `beforeMCPExecution`, which names both.
 * Unknown events and malformed input are refused: a vendor upgrade cannot
 * widen access. An allowed call gets no decision at all, as cursor expects.
 */
```
