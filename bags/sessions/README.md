# Session lifecycle and records

This bag owns the durable store, lifecycle bookkeeping, and searches over prior work.

Every process reads and writes a session's SQLite store directly through `@barry-rocks/sessions-bag/client`, routed to the store that holds the session. SQLite's WAL keeps concurrent writers safe, and each message's sequence is assigned by its own insert, so processes appending to one session agree on its order. What has to live in one always-on process lives in the sessions API: the delivery state (see [Messaging](#messaging)) and the OTLP receiver at `/v1/logs` and `/v1/traces`. Other processes reach it with the installation credential; device credentials are refused there.

Process start/end and stamping use the installation control store. Process mutations retain the parent record's database provenance and lock its store before mutating control history. Process adoption requires an existing open Session with no end timestamp and holds its writer lock until control history commits. Prepared inactive open Sessions can register their process; terminal Session states cannot. State-only closure/archive changes also capture cleanup. The node process table no longer has a local foreign key to partition-owned sessions; migration preserves history and monotonic IDs. Cross-file end/delete writes capture durable process cleanup intents in the Session transaction, with original source owners and exact process-instance bindings. Cleanup runs after commit, when the partition reopens, and through the sessions API's background recovery; acknowledgement follows the control-store commit, so a crash can safely replay the intent without closing or deleting a replacement. Each read drains at most 64 intents. Automatic Session location lookup checks every existing partition and the node catalog through read-only connections, including committed WAL rows, and refuses resolution on duplicate IDs. This detects conflicting locations but does not yet enforce atomic global uniqueness during creation or migration. Native/Kysely connections install the capture triggers. The sessions API starts recovery after listen and polls every 30 seconds, visiting at most 32 directory entries/eight existing stores and 16 intents per store under a 200ms cooperative work budget and 25ms SQLite busy waits. It holds bounded cursors, skips poisoned intents without dropping them, refuses files outside the active generation, and stops applying after generation changes. Sources are opened with fileMustExist and closed after each visit; recovery does not migrate them. Capture streams control history into one intent per exact process instance, so long histories never become one JavaScript array. Older aggregate arrays are split transactionally in SQLite before replay, preserving owner, target and timestamp metadata. Replay remains bounded per instance; malformed or individually oversized (>1MiB) values remain recorded. Offline SQL writers, legacy terminal rows without intents, immutable generation/adoption provenance, legacy normalization under real infrastructure stalls and atomic global Session uniqueness remain required lifecycle acceptance work.

Process instance identity consists of its history ID, session, PID, PID start time, host and recorded start time. Changing PID, PID start time or host closes the old history row and creates a new ID in one transaction; metadata updates for the same instance retain the ID. `markProcessInstanceEnded(instance, reason)` is available through the client and closes only an exact matching live record. Delayed or repeated closes cannot end its replacement. Durable cross-file lifecycle intents/recovery remain required; this binding is their identity foundation.

## Liveness

| Field | Meaning |
|---|---|
| `status` | Work outcome; `pending` between turns, `running` while streaming, terminal after closure |
| `active` | Whether the session is still open |
| `state` | Whether its record is open, closed, or archived |

A live record has `active = true` and `state = 'open'`. `pending` alone says nothing about process liveness: a healthy session waiting for its next prompt is pending.

Process lifecycle is tracked in the authoritative `processes` table (`src/store/processes.ts`). When a CLI or API session starts, its PID, start time, parent PID, command, and process name are recorded in `processes`. The child process exit handler deliberately does NOT clear the process or PID on exit: a stale PID is safe under PID-reuse verification and allows the reaper its 5-minute proof window to distinguish abnormal crashes from clean exits.

[classifyProcessLiveness](src/process-liveness.ts) is the shared authority for process checks. Match the PID **and** its start time because PIDs are reused. An absent PID, another host, or a failed probe yields unknown; unknown must never mean dead. The API's in-memory session map contains only sessions that process drives, so absence there cannot justify closing a CLI session.

`endSession` is the closure funnel: it clears active, closes the record, stamps the end time, and preserves an already chosen terminal outcome. The reaper handles provably dead processes using `listReapCandidates` from the `processes` table (stamping surviving processes each sweep to prevent starvation), API boot reconciles interrupted running rows, and a long idle sweep handles cases the process check cannot decide. Do not shorten the idle sweep to clean up a few rows: it measures time since the last message and can close live sessions resting between turns. Merge metadata updates partially to avoid concurrent writers dropping one another's keys.

The reaper refuses a batch in which more than half the processes appear dead. Its dry run and considered counts make probe failures and empty scans visible. [Lifecycle QA](src/lifecycle/QA.md) covers the checks.

### What a restart does

Restarting the always-on API (`barry service restart sessions.api`) loses every piece of state the process holds in memory and recovers the rest from the store. Operators should expect:

- **Hosted engines die.** On exit the API kills every harness it was holding (`engines.stopAll()` in `api/src/index.ts`). A v1 hosted turn in flight is lost mid-turn: the user message row exists, no assistant row follows, and the row is reconciled from `running` to `pending` on the next boot only when the pid is provably dead. A v2 durable turn (AG-UI) survives as `recovery_required` and is resumed by the turn executor, because its progress is in `session_turns`/`session_execution_events` rather than in memory.
- **In-memory budgets and registries reset.** The resident-session budget, the turn semaphore and its queue (so `turn_queue_full` 503s clear), the detached run slots, the listener registry, the wake budget, the pending-notifier and the sessions picker cache are all rebuilt empty. A session that was resting between turns resumes transparently; a caller that was being throttled is not.
- **The store is the source of truth.** Boot reconciliation rewrites interrupted `running` rows to `pending` where the owning pid is provably dead, closes active rows that have no pid at all, and replays cross-file cleanup intents. It never recreates a `sessions.db` that has vanished — a lost store is refused rather than silently re-made.
- **Readiness reflects the store.** While the store is unreachable, `/health` answers 503 (`/health/live` still answers 200 because the process itself is up), so a supervisor restarts the service on a lost store instead of leaving it reporting healthy.


## Message provenance

Subagent tool calls are stored under the parent session with `parentToolUseId`. Summaries exclude tagged rows and UIs can distinguish them from the parent's own work. There are two ingestion routes: SDK messages carry `parent_tool_use_id`; CLI hooks carry `agent_id`. Fixes need to cover both. Nested calls preserve the innermost agent tag, not the full tree. Subagent assistant text is not covered by the same CLI tool-call route.

### How a row was captured

Barry learns what an agent said and did through up to five routes, and every persisted row records which one it arrived on in `channel` ([the vocabulary](src/capture/channels.ts)):

| Channel | Source | Best possible completeness |
|---|---|---|
| `engine` | Barry held the engine handle and saw the event directly | total |
| `telemetry` | pushed by the vendor's OpenTelemetry (claude guest-plus) | near-total — bodies truncate at 60 KB and thinking is redacted |
| `hook` | reported by a vendor hook (cursor's `postToolUse`) | near-total |
| `mcp` | Barry's own tools recorded the call | post-hoc — only calls that went through Barry |
| `transcript` | read from a file the vendor writes | post-hoc, and unstable by the vendors' own word |

A `telemetry` row is attributed to a session only by the provider session id in the pushed batch, behind the API's shared-secret auth and loopback binding. Its provenance is therefore only as trustworthy as the secret: any process holding the installation credential can push an `assistant` row for a provider session id it knows. That is acceptable for a single-user, loopback-only service, but it is the reason telemetry is a distinct `channel` and not conflated with `engine` — a row Barry saw directly on the handle it held.

`channel` is **nullable, not defaulted**. A default would stamp every row written before provenance existed with a channel nobody observed, making "we don't know" indistinguishable from "Barry held the handle" — which is the confusion the column exists to remove.

The same utterance can arrive on more than one route, so a row may carry a `dedupe_key`: the identity of the entry within its source, stable across re-reads. A row whose key is already stored is dropped rather than inserted again, which makes re-reading a transcript — or a backfill overlapping a live stream — a no-op instead of a silent doubling. Engine rows carry no key: that path sees each event exactly once.

A guest session with tool calls and no capture rows is an **alert**, not silence — but a broken reader and a quiet agent both produce nothing, so [the counters](src/capture/coverage.ts) count what was *attempted* beside what was stored. Locating no transcript for any session means the search path is wrong, not that the sessions were quiet; reading hundreds of lines and parsing zero entries means the reader has stopped understanding a format the vendor changed.

## Messaging

The sessions API's `POST /api/v1/prompts/wait` accepts up to 100 watched session IDs and a timeout up to 25 seconds, and stops when its caller disconnects. Ready IDs are hints, including retry notifications: waiting never consumes a message, so delivery still uses the normal prompt operations.

Every cross-session message is a pending row in this store. Every surface drains it through the atomic `popPrompts`, so a message is delivered at most once however many surfaces are live, and every surface delivers the same text — [one formatter](src/delivery/format-inbox.ts) names the sender and the channel it came from.

`send_message` and `POST /sessions/:id/message` return what will actually happen to the message, computed from the recipient's **registered listeners** and its state. Never inferred from the adapter's name: a surface claims a guarantee only while it is running, heartbeats to keep the claim, and loses it when it stops.

| Reported | What it means |
|---|---|
| `wake` | An idle session starts a turn now, framed as a user turn. The API's [inbox relay](api/src/inbox-relay.ts) does this for every session it hosts |
| `wake-peer-framed` | A turn starts now, but the vendor frames it as mail from another session rather than as the user — claude guest-plus over its [inbox socket](../../adapters/sessions/claude/src/inbox-socket.ts) |
| `turn-end` | Read when the current turn finishes |
| `tool-call` | Read on the session's next Barry tool call. The floor for any running session |
| `on-resume` | The session is not running; held and delivered when it restarts |
| `none` | Nothing can reach it. The message stays queued |

A [wake budget](src/delivery/wake-budget.ts) caps wakes per recipient and per sender pair, so two sessions told to reply to each other stop. Over budget the message is **not** dropped: it keeps its place in the inbox and loses only its wake, and the sender is told which limit refused.

The wait is a long poll that only peeks — draining there would make the wait itself the delivery and lose the message when a caller dies in flight. A prompt queued in the API's own process wakes it at once; one another process writes straight into the store is found by a recheck within a second. The listener registry and the wake budget live in the API's memory too, so a restart forgets them. Other processes reach all three at `/api/v1/prompts/*`, and an API they cannot reach is an error to them, never `none` or an allowed wake.

## Scheduled prompts

"Check back on this in 20 minutes" is `schedule_prompt` (`in: 20m` or `at:` an ISO time). It is always available in a session and needs no configuration: it books a one-off [schedule](../schedules/README.md) of the `deliver-prompt` action, whose run posts the prompt through the same route a person's message takes. A session that has stopped is resumed with it, so the agent does the check at the due time. A session live in a terminal can only have it queued in its inbox, which it reads with `pop_message`, so delivery also records a notification. The schedule id keys the message, so a retried delivery never arrives twice. `list_scheduled_prompts` shows the pending ones; cancel one with the schedules bag's `cancel_schedule`, which takes the same id — a scheduled prompt *is* a schedule, so it never needed a second tool of its own.

## Search and bookkeeping

| Tool | Searches |
|---|---|
| `list` | Name, prompt, summary, and explicit date/directory/branch filters |
| `search` | ID, directory, branch, remote, directive, name, tags, summary |
| `search_messages` | User and assistant message content ([session-vector-search](../session-vector-search/README.md)) |

A session whose name and summary omit a topic may still be found in its messages. Provider conversation IDs map back to Barry session IDs through `get(provider_session_id: ...)`; supply either that ID or the Barry ID, not both.

The bookkeeping schedule adds names, tags, and an append-only ledger. User-set names win. Tags accumulate; derived repo and branch tags provide facts even when a model omits tags. A message-sequence watermark prevents repeat inference on unchanged work. The ledger drops old entries when capped and preserves topic-change markers preferentially.

The recurring run scans a bounded recent window. Older sessions need the explicit backfill mode. Configuration and defaults live in [the manifest](bag.yaml) and [bookkeeping](src/bookkeeping.ts). Missing Ollama or a missing model makes the run skip work; a successful process exit alone does not prove the ledger advanced. Use its considered/written/model-call counters. Changes to drift detection need the evaluation described in [QA](QA.md), because ordinary unit tests cannot measure a prompt's false positives or recall.

## App Protocol (v1)

Sessions are accessible to external applications (macOS, iOS, Web, and ACP clients) via the versioned **App Protocol v1** over WebSocket and HTTP.
The protocol covers:
- **Protocol negotiation & handshake**: versioned `subscribed` frame advertising capabilities (`streaming`, `thinking`, `gating`, `listener`, `attachments`).
- **Interactive tool-call gating**: the compatibility WebSocket projects v2 interrupts as `permission_request`, and `ruling` resolves those same durable interrupts. Set session metadata `review_policy: {mode: "review_required"}` to opt in; compatibility turns otherwise use automatic policy. Interactive turns get a persisted 60-second deadline unless an explicit `expiresAt` is supplied, and expiry denies the pending batch, including after downtime. Approvals cannot override current session bounds.
- **File attachments**: upload via `POST /sessions/:id/attachments`, storage under `<app-support>/attachments/`, and bounded session workspace materialization.
- **Delivery guarantees**: `register_listener` with `client` listener kind for wake guarantees.
- **App SDK**: typed client in `@barry-rocks/sdk/apps/client`.

`capabilities.gating` is true only for a prepared hosted session whose actual or declared mode supports per-call rulings. Hook-only and static modes, and unknown inactive sessions, report false. Approval runs and scoped subagent grants refuse modes that cannot enforce per-call decisions with a visible 409 diagnostic. A compatibility WebSocket turn also requires live or durable approval continuation support. The HTTP ruling routes operate on these v2 interrupts; legacy HTTP prompt delivery and inbox migration remain tracked in review-resolution Step 20.

### WebSocket message inventory

The following client messages are accepted by the v1 WebSocket. Session mutations
require authorization; declaring a message type does not grant permission.
The subscribed handshake contains the capability fields listed below.

| Kind | Name | Purpose |
| --- | --- | --- |
| client | `subscribe` | Subscribe to a session and negotiate protocol version. |
| client | `activity` | Renew the attached session’s idle process lease. |
| client | `unsubscribe` | Stop the session subscription. |
| client | `message` | Submit a compatibility turn. |
| client | `start` | Start a hosted session. |
| client | `stop` | Stop a session. |
| client | `remove` | Remove a session. |
| client | `list` | Request the visible session list. |
| client | `subscribe_topic` | Subscribe to a bus topic. |
| client | `unsubscribe_topic` | Stop a bus topic subscription. |
| client | `register_listener` | Register delivery guarantees for a client listener. |
| client | `ruling` | Resolve a durable pending tool-call interrupt. |
| capability | `streaming` | Session event streaming support. |
| capability | `activity` | Client idle-process lease renewal support. |
| capability | `thinking` | Provider-exposed summarized thinking deltas; ephemeral and never stored. |
| capability | `gating` | Per-call approval support for this hosted mode. |
| capability | `listener` | Client delivery-listener support. |
| capability | `attachments` | Attachment support. |

## Mailgun webhook signing

The incoming-mail webhook reads `MAILGUN_SIGNING_KEY` through the installation's named secret bindings. An unauthored binding disables the webhook; an authored but unavailable binding fails closed. Shell environment values are ignored, and rotation is picked up on the next request.

For a private-file binding, add this reference to the installation configuration at `barryConfigDir()/barry.yaml`:

```yaml
secrets:
  MAILGUN_SIGNING_KEY:
    in: .env
```

Store its value in the private `barryEnvPath()` file, or declare a Keychain/vault reference using the same installation secret contract. The value does not belong in the service manifest. `MAILGUN_MAX_AGE_SECONDS` remains non-secret service configuration, defaults to 300, and must be a positive integer.

### Thinking and effort

`thinking` frames carry `{ type: "thinking", sessionId, content, parentToolUseId? }`.
They contain the provider's exposed thinking summaries, never hidden reasoning or signatures.
A subscriber receives the current thinking buffer before partial answer text; thinking is not transcript history.
Unknown frame kinds must be ignored. `BARRY_TOOL_INPUT_STREAMING=1` additionally enables
`tool_input_delta` frames with `toolUseId` and JSON input deltas.

The default model effort is unchanged. Set `adapters.claude-code.effort` on an identity
with `barry identity adapters set claude-code --effort high` (also accepts `low`, `medium`,
`xhigh`, and `max`). Children inherit it unless overridden. A session can PATCH
`{ "metadata": { "effort": "high" } }`; null restores its inherited setting.
The override applies when the harness is reopened. Routed model endpoints do not receive
Claude-specific thinking or effort parameters.

Hosted clients may call `barry session interrupt <id-or-prefix>` to finish the current turn while keeping
the session reusable, or `barry session stop <id-or-prefix>` to force cancellation and end the session.
The interrupt response includes `status: interrupted|forced|none` and a message. Stop may include
`recordingPending: true`; accepted transcript rows continue recording after the resident is released.

Live frames and session listings may include `lastEventAt` (ISO timestamp or null). A forced turn sends
`status: waiting` with `metadata.code: turn_forced`. Exceptional sequence repair sends
`delivery_update.metadata: { code: sequence_reassigned, oldSequence, newSequence, dedupeKey }`.
Durable rows carry the same optional `dedupeKey`; clients should deduplicate corrected replay by it.
Older clients can show a duplicate after repair rather than lose the accepted message.
