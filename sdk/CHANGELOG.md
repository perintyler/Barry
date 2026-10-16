# @barry-rocks/sdk

## 0.1.0

### Minor Changes

- 8bd1e45: Sessions answer more. `SessionQuery` takes `active` and `order: "activity"`. `Session` carries optional `branch`, `transcriptPath`, `hostname`, `pid` and `pidStartedAt`. `session.messages(query)` reads after or before a sequence, newest first, or briefly; `session.message(sequence)` and `session.listening()` are new. `Barry.lastChanges(paths)` answers in a process that hosts the tracker (over HTTP it is unavailable), and `Change.sessionId` names the session that made a change, or is null when that session belongs to an identity the caller may not see. Code that implements the `Sessions` or `Tracker` subject adds `message`, `listening` and `lastChanges`, and takes the new `query` argument of `Sessions.messages` before the cursor; code that builds a `Change` sets `sessionId`.
- 2f33dc1: First versioned SDK. The version describes the stable entries in the SDK's README; internal entries carry no promise and are not versioned. The SDK is not published to npm: a bag links the SDK of the installation it runs with.
  
  Since the SDK was trimmed there is one entry per subject. `BarryClient`, `BarryApiError` and the raw-client, one-off and pairing types left the root entry: use `Barry`, or `@barry-rocks/sdk/internal/client` in Barry's own hosting code. The old leaf entries no longer resolve.
- 335699f: An identity names the harness adapters it runs on in one `adapters` map, keyed by harness id, each entry `{ default?, model?, mode? }`. `Identity.adapters` is the effective map after inheritance, and `IdentityUpdate.adapters` sets the intended effective map (`null` clears the identity's own entries). The new `AdapterSettings` and `IdentityAdapters` types are exported from the root entry.
  
  `Identity` loses `defaultCodingAgent`, `defaultModel`, `defaultModelProvider` and `allowNativeTools`, and `IdentityUpdate` loses `defaultHarness`, `defaultModel`, `defaultModelProvider` and `allowNativeTools`: read and write `adapters` instead. The HTTP API (`/openapi.json`) changes the same way, and a request still sending the old identity fields is refused with 400. In `/adapters/models`, `RouteRequest` no longer takes `defaultHarness`, and its `identity` is now `{ model }`, the identity's model for the harness being routed.
- fdac1b9: Native tools are on by default and restricted by bounds (`<harness>:<ToolName>` or `*:<ToolName>` in `bound.tools.deny`), and each shipped adapter's bag ships `no-shell`, `no-file-reads`, `no-file-writes` and `no-network` bounds where the harness has such tools. A mode declares what it can do with its harness's tools in `Mode.native` (`NativeControl`: `controllable`, `inseparable`, `uncontrolled`, `operatorOverride`); a mode without it can control nothing. `SessionConfig.allowedNativeTools` carries a session's allowance, and `configureHarnessSession` takes the mode's `NativeControl` as a third argument.
  
  `Tool` gains `unavailable` and `uncontrolled`, and `session.tools()` now lists the harness's own tools a session may use, refused or cannot turn off, with `bag: null`.
  
  In `/bounds`, `resolveNativeTools(bound, explicitBounds, harness, mode)` returns `{ allowed, denied, refused, uncontrolled, operatorOverride }` instead of a list of denied names, and `validateNativeTools` validates adapter bounds against `NativeHarness`. `/services` now exports `stableNodePath()`, the Node an installed hook command should name.
- 5855ffe: `Services` and `ServiceHandle` gain `start` and `stop`, and `Barry.services()` and `Barry.service(key)` now work over HTTP: pass the MCP server's address and credentials as the `services` connection option (`localConnection()` from `@barry-rocks/sdk/services` finds `mcp.server` itself), and `/openapi.json` publishes the five services operations. Code that implements `Services` must add `start` and `stop`; `fakeServices` covers both. Over HTTP, a session caller's start, stop or restart is refused as `forbidden` without sending a request.
- d88f826: A bound is one type, `Bound`: the rules, with an optional `name` and `description`. `AgentBound` and `AgentBoundSchema` are renamed `Bound` and `BoundSchema` (root and `/bounds`), `NamedBound` is gone, and `Barry.bounds()` returns `Bound[]`, each named. `mergeBounds` returns an unnamed bound.
  
  Bounds are selected by name only. `SessionStart` and `SessionUpdate` take `bounds` (names) instead of `bound`; `Session` carries `bounds`. `Identity.boundId` is gone and `Identity.bounds` lists the identity's required bounds; `IdentityUpdate` takes `bounds` instead of `bound` and `boundId`. `Identity.bags` and `IdentityUpdate.bags` are the required bag names, and `Barry.identity(ref).bags()` and `Barry.identity(ref).bounds()` list the identity's entries.
  
  The HTTP API (`/openapi.json`) changes the same way: `GET /bounds` answers flat, named bounds; identity and session bodies take `bags` and `bounds`, and a body still sending `boundId` or an identity `bound` is refused with 400.

## Before 0.1.0: former bags API notes

These historical notes describe the former package and its original version labels. They are retained as history, not current SDK instructions.


## 2.0.0

- Native MCP responses now require `mcpResult(...)`; objects with `content` are ordinary data.
- Empty returns produce successful empty responses.
- Output schemas and app metadata appear in standalone discovery. Declared output schemas are validated.
- `adaptMcpTools` replaces `createMcpRegistrationAdapter`, which is removed along
  with the `McpRegistrationAdapter` and `McpRegistrationAdapterOptions` type aliases.
- Zod 4 enums work in the CLI adapter.
- The `session-store-drops` subpath is gone. The drop-line format moved to
  `@barry-rocks/session-client`, its only writer; it was never part of the
  bag-authoring API.

## 2026-08-24

- `capText` gains an optional `marker` for callers with their own marker text
  (storage-side truncation); default markers unchanged.
- `startBagServer` honors an explicitly-set `BARRY_TOOL_RESULT_CHAR_LIMIT` by
  opting the stdio server into result capping (still uncapped by default —
  external hosts apply their own limits).

## 2026-08-20

- New `truncate` subpath: `capText`, `capToolResult`,
  `DEFAULT_RESULT_CHAR_LIMIT` (100k chars), `resultCharLimitFromEnv()`
  (`BARRY_TOOL_RESULT_CHAR_LIMIT`).
- New `paths` subpath: `resolveUserPath` (tilde + relative resolution; throws
  on `~user` and on `~` with `HOME` unset).
- `registerTools(server, tools, options?)` accepts `resultCharLimit` to cap
  every result's text content at registration. **Opt-in, default off** — the
  published API is behavior-unchanged unless a host passes a limit. Error
  messages are capped before credential guidance is appended, so remediation
  text survives.
