# mcp

The Barry MCP server: one process, the `mcp.server` service, serving every bag's tools to every session. Local bags' tools run in-process and remote bags are proxied. For each session it turns traits and bounds into a tool list, injects the session's secrets, and wraps the edit tools (intent and locks, read-before-edit, change recording).

It is a bag like any other: `bag.yaml` declares the `server` service, and the base identity packs it. It is also one of the three composition roots, so it imports the bags it serves (identities, sessions, locks, tracker), which its manifest `requires:` so that unpacking one is refused.

## Entry points

- `src/server-main.ts`: the server executable. `/mcp` serves core tools and `/mcp/ns/:namespace` one bag's, so they appear as `mcp__<bag>__<tool>`; also `/health`, `/bag-status` and `/refresh-tools`. `--stdio` serves over stdio instead.
- `src/application.ts`: the Express HTTP + MCP server implementation.
- `src/read-tracking.ts` and `src/edit-arbiter.ts`: the per-session tool execution arbiter.

## Worth knowing

- To apply changes to the server: `barry service restart mcp.server`. The old name, `barry.mcp`, is accepted for one release.
- Testing: [historical QA](../../cli/docs/mcp-qa.md).

## Service control

The bag supplies the `services` subject. The CLI and MCP server install it so
`Barry.services()` and `Barry.service(key).get()` or `.restart()` run in-process.
The deferred `services_list`, `services_status` and `services_restart` tools use
the session's caller. Selecting the `mcp:services` trait grants service control;
a read-only bound removes restart access. Devices cannot reach the subject.
A bag acting for a session may control its own services without that grant.
The server cannot restart itself; use `barry service restart mcp.server`.

Other processes reach service control over HTTP: `GET /api/v1/services`, `GET /api/v1/services/{key}`, and `POST /api/v1/services/{key}/{start|stop|restart}`. These owner-only routes are available before the toolset finishes loading.
