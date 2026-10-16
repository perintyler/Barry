# 0049: Streaming delivery before recording

Accepted 2026-10-14.

Hosted turns acknowledge admission with HTTP 202. The response does not wait for harness warming or a completed turn. `starting` (preparing/initializing/retrying), `streaming`, and `waiting` are distinct lifecycle phases. The HTTP timing header describes ingress/admission; the waiting frame carries the turn summary.

The Claude adapter requests vendor-exposed summarized thinking and streams it as ephemeral `thinking` deltas. This is the provider's public summary, not hidden reasoning. Thinking is never stored in the transcript. Default effort is unchanged. Identity adapter `effort` and session PATCH `metadata.effort` optionally select low/medium/high/xhigh/max. Routed endpoints retain their compatibility guard. Fine-grained tool JSON requires `BARRY_TOOL_INPUT_STREAMING=1`.

The resident owner allocates durable sequences before publication and places writes in one FIFO. Tool results retain the existing folded-row representation. Partial, thinking, and status frames never wait for SQLite. Resident recording runs the shared persistence core on a worker thread with a separate connection: even its five-second busy wait cannot block the model/socket event loop. Sessions use WAL `synchronous=NORMAL`. A process crash can lose rows still in memory; a power loss can also lose recent WAL commits. Graceful shutdown drains for 30 seconds and reports failure rather than claiming durability. No schema migration is required.

The recording queue retains every admitted event. Admission thresholds are 4 MiB per session and 64 MiB per process; an admitted turn may exceed them to finish. New turns receive retryable HTTP 503 at the threshold. Failed writes retry with 100 ms–5 s backoff. A failure, exceeded threshold, or one-second delay emits `status.metadata.code=persistence_lagging`; recovery emits `persistence_recovered`. A sequence collision retains the write and repairs it in FIFO order. Published sequence corrections emit an explicit old/new mapping with stable identity; ambiguous retries are idempotent. Admission remains refused while an invariant failure is unresolved.

Reads flush for one second. If recording has not caught up, message reads merge pending events with committed rows, mark `durable=false` and `X-Barry-Durability: pending`; cold history includes the pending events with an explicit recording-delay marker. These responses must not imply the pending rows survived a restart. The transcript sweeper skips resident sessions to avoid competing with the complete engine capture path.

Sockets cork streaming bursts and coalesce only adjacent compatible partial/thinking frames above 32 frames/256 KiB. Status, tool, and durable frames are barriers. Hard limits remain 512 frames/4 MiB; a permanently stalled reader must reconnect. Streaming authorization is revalidated at most once per second and immediately on invalidation. Non-stream publications retain a fresh check. This preserves revocation checks on control/topic traffic. Durable compatibility subscriptions share one event-driven reader per store/session with a one-second safety poll while a turn exists.

Subscribe omits negative sequences, advertises `capabilities.thinking`, and replays thinking before partial. `afterSequence` requests durable replay with live capture during the read. `activity`/subscribe renew the idle process lease. Claude keeps idle processes for 30 minutes by default (`BARRY_CLAUDE_IDLE_RELEASE_MS`); process liveness, rather than a historical prepare timestamp, determines `warm_hit`. Initialization uses SDK startup when available, a 60-second warm/120-second turn deadline (`BARRY_CLAUDE_INIT_TIMEOUT_MS` overrides), aborts failed spawns, and retries a turn initialization once.

btui 0.3 consumes unknown frames safely, subscribes early, holds only durable frames for history catch-up, caps streaming draws at 60 Hz, and commits complete paragraphs to scrollback. Thinking is muted and transient; Ctrl-T or `/thinking` expands its tail. `--timing`/`BTUI_TIMING=1` prints comparable client/server timing. `BTUI_SEND` lets `bux -p` display the user line before the POST completes. The raw terminal consumes deltas too.

Measurements and limits are in `performance/streaming-step-*.json`. Integrated samples must not be mistaken for isolated per-change causal measurements. Model time, initial provider setup, host scheduling, and disk pressure remain visible in those records.

## Review follow-ups (2026-10-15)

Summarized thinking can arrive only shortly before text; it is not a reliable early-activity signal.
Clients display starting immediately and thinking with elapsed time from streaming. `warm_hit` means
`Session.isWarm() === true` after any shared warm completes. A prepare timestamp alone is not evidence
of a running process. Current-turn timing is separated from the session's original preparation numbers.
Older measurements that inferred warmth from prepare stamps retain their original data and are
superseded for warm/cold classification.

Hosted sessions use one aggregate MCP server by default, preserving the MCP server's grant filtering.
Legacy service environment overrides cannot enable namespace splitting for all hosted sessions.
An identity can explicitly set `adapters.<harness>.namespaceSplit: true` and inherit/override that setting.
Doctor reports a running API whose namespace flag drifts from the manifest. Queue wait and native-send
callback latency are reported independently. Durable/control publications retain immediate authorization
checks; streaming deltas retain the one-second validation window and explicit invalidation.

A foreign prompt writer routes to the resident API's inbox. SQLite worker recovery uses a write
transaction to rebase collisions in FIFO order. An already-published frame keeps its stable `dedupeKey`;
`delivery_update.metadata` reports `code: sequence_reassigned`, `oldSequence`, `newSequence`, and
`dedupeKey`. Updated clients deduplicate corrected replay by stable identity. Older clients may show a
duplicate after an exceptional collision; transcript loss is never the fallback.

Stop owns cancellation independently of adapter acknowledgements. Interrupt waits for turn completion
for at most ten seconds, then forces a fresh harness on the next turn; stop forces cancellation immediately.
The forced path publishes waiting with `code: turn_forced` and monotonic `silentMs`. `lastEventAt` is an
optional ISO timestamp in live frames and session listings; silence does not imply failure. Accepted
persistence entries survive resident removal. Stop reports `recordingPending` while the transcript drains,
and reopening refuses until recording/finalization finishes. See the [adapter contract](../../sdk/src/sessions/README.md).

btui retries failed history catch-up once while releasing buffered live output. Its collapsed thinking
line fits physical terminal columns, and Ctrl-C escalates from interrupt to stop even while the first
HTTP request remains pending. A successful hard stop exits 130. The CLI gates `BTUI_SEND` on btui 0.3+
and submits prompts itself for older clients. Raw thinking rewrites one dim line and separates the answer.
