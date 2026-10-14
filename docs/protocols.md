# Protocols

The wire protocols Barry speaks, and which direction each one runs. Two are open
standards Barry interoperates with (ACP and MCP); one is Barry's own session
execution protocol (AG-UI).

| Protocol | Direction | Carries | Entry point |
|---|---|---|---|
| [ACP](#acp) | both | a whole agent session, over stdio | `acpHosted` (inward), `barry acp` (outward) |
| [AG-UI](#ag-ui) | client to Barry | Barry's v2 session execution and event stream, over HTTP | `AgUiConnection` from `@barry-rocks/sdk/apps` |
| [MCP](#mcp) | agent to tools | tool discovery and invocation | a bag's MCP server |

## ACP

The [Agent Client Protocol](https://agentclientprotocol.com) is an open standard
for an editor (the client) to drive an agent. Because it is a standard, Barry
speaks it in both directions, and both live outside the harness adapters.

**Inward**: `acpHosted` is a hosted session mode for any harness that speaks ACP
on stdio. The harness runs as a stdio subprocess, Barry answers its mode
guarantees, and the result is a full hosted session. Cursor's hosted mode uses
this (`cursor-agent acp`). The contract is in
[`sdk/src/acp/index.ts`](../sdk/src/acp/index.ts).

**Outward**: `barry acp` serves Barry itself as an ACP agent on stdin/stdout, so
an ACP-speaking editor (Zed, JetBrains, Toad) can drive a Barry session. The
command is in [`cli/src/commands/acp.ts`](../cli/src/commands/acp.ts).

A note on tool naming over ACP: Barry names a tool call from what the harness
reports, so a title like `MCP: tool` or a bare shell command is not a name a
denial list or server scope can match. The Cursor adapter's `identifyTool`
handles this; see [its modes](../adapters/sessions/cursor/src/modes.ts).

## AG-UI

AG-UI is Barry's version-2 session execution protocol. A client creates and
drives a session over HTTP and subscribes to its event stream. It is served by
the sessions API and consumed through `AgUiConnection` from
[`@barry-rocks/sdk/apps`](../sdk/src/apps/connection.ts).

```ts
import { AgUiConnection } from "@barry-rocks/sdk/apps";

const connection = new AgUiConnection({
  baseUrl: "https://barry.example/api/v2/sessions",
  secret: token,
});
try {
  for await (const { cursor, event } of connection.subscribe(sessionId, {
    signal: controller.signal,
    reconnect: { maxAttempts: 3, delayMs: 250 },
  })) {
    render(event);
    saveCursor(cursor);
  }
} finally {
  connection.close();
}
```

Key behaviors:

- **Lazy and cursor-based.** Subscriptions read on consumer demand. Persist a
  delivered `cursor` and pass it as `after` to resume where you left off. Replay
  duplicates are suppressed, including individual frames within a committed
  sequence.
- **Reconnects are GET-only.** Optional reconnects issue GET requests, use
  exponential backoff capped at 30 seconds, and allow at most ten attempts across
  one subscription. Authorization failures and malformed responses never
  reconnect. Run, queue, and cancellation writes are never automatically retried.
- **A WebSocket transport exists too.** Device clients can subscribe over
  `/api/v2/ws`, under the same read and subscribe scopes and the same session
  ownership checks as the SSE-style event stream.

Streams reverify the original credential and the resource policy before the first
frame and each later frame, and again periodically while idle. A failed recheck
ends the stream. See the [SDK README](../sdk/README.md) for the full streaming,
credential, and request-control contract.

> A legacy v1 WebSocket session/topic protocol also exists for older local
> clients. It requires an installation credential and is not available to
> devices, which use the scoped v2 subscriptions above. New clients should use
> AG-UI.

## MCP

The [Model Context Protocol](https://modelcontextprotocol.io) is how Barry serves
*tools* to agents. A bag defines a tool once and serves it over MCP; one bag owns
each MCP server declaration, and composing that owner is how other bags reuse it.
A session only discovers a bag's tools when it enables that bag, and every
namespace gets its own endpoint so the agent sees `mcp__git__*` and
`mcp__linear__*` rather than one flat surface.

Authoring tools and serving them is covered in
[the bags SDK docs](../sdk/docs/bags.md); the host supplies session context,
declared secrets, and policy enforcement around each call.

## See also

- [Adapters](../adapters/README.md): session modes and how harnesses connect.
- [SDK README](../sdk/README.md): the AG-UI streaming and credential contract.
- [Bags SDK docs](../sdk/docs/bags.md): defining and serving tools over MCP.
