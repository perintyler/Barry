# Lightning McQueen

Fast-session implementation, review fixes, and verification.

Recorded: 2026-10-14. All review findings are addressed; no mediums or lows remain open.

The follow-up fixes landed in `897e2386e`, the banner cache correction in `dfc53b419`, the timing audit in `7fc2abf27`, and the advisory health probe in `c9da7c721`.

## Review findings

### High severity

- Protect subscribers from budget eviction; preserve prepared rows on eviction/shutdown/reconciliation; idle TTL still cleans abandoned drafts.

### Medium severity

- **Medium 1:** grant namespaces remain the guest MCP fallback.
- **Medium 2:** offline unbound guest/instrumented launches warn and continue; hosted/bound pre-create failures and confirmed build-skew refusals remain fatal; failed health probes are advisory before required creation.
- **Medium 3:** cold attach/message admission allow 60 seconds; uncertain message sends retry once with the same `clientMessageId` and report uncertain delivery after repeated failure.
- **Medium 4:** bundled input/package/JSON/directory stat stamps detect edits without launching Git; freshly built dirty sources remain usable.
- **Medium 5:** recheck cached build failures against source and dependency-install stamps; include cached failures in aggregate launch diagnostics.
- **Medium 6:** identity-sync success stamps are written only after successful trait sync; failed or timed-out sync retries next launch.
- **Medium 7:** prepared sessions without resumable provider ids replay prior transcript history.
- **Medium 8:** document cross-process secret-cache TTL and immediate revocation procedure.
- **Medium 9:** warm invalidation uses its own generation and preserves accepted queued first messages.
- **Medium 10:** disk caches retain invalid-manifest diagnostics and track both tools-entry candidates.

### Low severity

- Session list retains message-less live sessions while hiding unprepared drafts.
- Picker cancellation before precreation skips session end requests.
- Launch and picker banners show builtin hiding summaries, selected bounds and mandatory identity bounds.
- Trait-memory failure advice includes lock contention and retry.
- Sessions.api alone owns shared bag-build maintenance.
- Old manifest and snapshot generations are pruned, preserving recent concurrent writes and unrelated files.
- First messages racing warm initialization report `warm=1` in runtime timings and HTTP response headers.
- Claude startup initialization cap applies only to warm opens.

## Verification

Full-suite results below retain the distinction between the initial suite run and later targeted regressions or reruns.

| Check | Result |
| --- | --- |
| Sessions API | 760 full-suite tests passed; final HTTP warm-race regression passed with all 46 lifecycle route tests (761 unique tests) |
| CLI | 1488 passed, 6 skipped; final banner cache adjustment passed 30 preparation/parity tests and CLI typecheck |
| SDK | 2709 passed, 2 skipped; final loader diagnostics regression passed with all 37 loader tests (2710 unique tests) |
| Identities | 492 passed |
| MCP | 458 unique tests passed; transport cleanup load-sensitive case passed on targeted rerun; maintenance ownership runtime regression passed |
| Claude adapter | 125 passed, 7 skipped |
| Typechecks | SDK, CLI, sessions API, identities and Claude passed |
| Launch-parity goldens | byte-identical to 44e4a37b8 |

### External bags

All 70 of 70 registered bag builds passed. Repairs touched 68 import files, moving tool helpers to the canonical tools entry and store context to the internal store entry. The `todos` suite passed 42 tests.

These source edits remain in their owning external repositories and need committing there.

## Startup timing

`BARRY_TIMING=1`, exact `bux` identity binding, bundled CLI, real Claude/MCP/vault. Isolated API uses the real sessions app and stores, without unrelated managed-service background work. Warm samples follow the cold sample.

Entry: `bundle`. Measurements are in milliseconds.

| Measurement | Samples | Median | Target |
| --- | --- | --- | --- |
| Isolated cold launch → `ui:spawn` | 675.3 | — | — |
| Isolated warm launch → `ui:spawn` | 444.4, 337.2 | 390.8 | ≤ 500 |
| Bundled identity `--version` | 59.8, 51.5, 50.5, 108.6, 58.9 | 58.9 | ≤ 300 |

The isolated warm-launch and version gates passed.

Busy managed-service launch samples: 4139.9, 1625.9, 790.8, 1269.8 ms. Above the 500 ms gate while the managed service and host were busy; retain this operational limitation rather than treating the isolated gate as a guarantee under load.

Reuse cached composition builtin flags; avoid a 70–100 ms shipped-manifest scan introduced by restoring the banner.

### Earlier review-patch version timings

Before median: 49.4 ms. After samples: 274.3, 62.7, 65.9, 71.1, 67.5 ms; median: 67.5 ms.

## Deployment

Follow-ups landed on shared master. Installed SDK and bundled CLI rebuilt. sessions.api and mcp.server restarted sequentially; API health/live ok with sessions schema 20, MCP health ready. Unrelated staged and unstaged master patches verified byte-identical after each fast-forward.

## Advisory health probe

A timed-out or unreachable health probe warns and permits required hosted/bound pre-create. The pre-create retains its independent 5-second deadline and fatal failure behavior. Confirmed schema/build incompatibilities retain the existing refusal/restart policy; offline unbound guest recording remains optional.

52 API-skew, preparation and launch-parity tests passed; CLI typecheck passed. HTTP regression verifies that a nonresponding health endpoint does not prevent successful pre-create. Transport failure regression verifies that pre-create still reports its own failure.

The CLI-only change landed in `c9da7c721`, and the installed CLI bundle was rebuilt. API and MCP do not need another restart for this change.

## Hosted streaming (0049)

Opening the terminal and starting a turn are measured separately. `barry session bench <id> --prompts "…" --repeat 2 --json --ps` observes one authenticated socket before posting; `btui --timing` or `BTUI_TIMING=1` records Enter, admission, starting/streaming, first thinking/partial, final text, waiting, chunk gaps, draws, and the server summary. Run measurements without overlapping builds or suites.

Hosted message admission returns 202 while warming completes. The resident sends frames before recording them in a retrying FIFO. If recording falls behind, the stream continues with a `persistence_lagging` status; the byte limit refuses subsequent turns with retryable 503 rather than dropping transcript rows. Reads identify an in-memory fallback as `durable=false`. See [ADR 0049](decisions/0049-streaming-delivery.md) for the crash/power-loss tradeoff and queue policy.

Claude streams vendor-exposed summarized thinking. It can arrive well before answer text, but its arrival still depends on the model; it is not hidden reasoning and is never written to history. Default effort is unchanged. For an identity:

```yaml
adapters:
  claude-code:
    effort: medium
    promptCacheTtl: 1h
```

`barry identity adapters set claude-code --effort medium` sets effort; a session PATCH `metadata.effort` overrides it (null restores inheritance). A longer prompt-cache TTL is optional and has vendor pricing implications. Environment caches return old values during refresh only within the original TTL; explicit invalidation fences late refreshes. Removed/rotated secrets can remain cross-process cached for the documented TTL.

btui 0.3 accepts fresh-session handshakes, subscribes alongside history loading, streams paragraphs into scrollback, and caps streaming draws at 60 Hz. Ctrl-T or `/thinking` expands the muted thinking tail. `bux -p` hands its prompt to btui so the user line appears before the POST finishes. `--ui raw` renders deltas too.

The retained integrated measurements are in `performance/streaming-step-*.json`. Individual changes were not isolated in those integrated samples. Under the measured host load, short warm POSTs were 107–180 ms; one second warm turn reached first partial at 659 ms. Longer thinking turns delivered 532/33 thinking frames and native send p95 was 1.38/1.68 ms, with 12.6/25.5 ms maxima. Model gaps and cold setup remain; these figures do not certify every latency gate.

The final worker-backed checkpoint acknowledged warm turns in 34/39 ms, with starting visible at 36/40 ms. Its second native-send p95 was 0.92 ms (max 2.03 ms). In an actual btui three-paragraph turn, Enter-to-first-draw rounded to 0 ms, POST was 71 ms, first thinking/partial 1907/1911 ms, and waiting 7573 ms; 104 chunks produced 197 draws (26/s), gap p95 65 ms, and server native-send p95/max 0.34/4.15 ms. The model stream finished through a sequence conflict caused by the old managed API's transcript sweep of the private probe. The queued rows were retained, the duplicate capture rows were backed up and removed only for that throwaway session, and the recording warning cleared on retry. This validates the failure behavior; it is not a quiet model-TTFT benchmark.

Validation: sessions API 777 passed; Claude adapter 132 passed (7 intentionally skipped); MCP 458 passed; SDK 2713 passed (2 skipped); CLI 1492 passed (6 skipped); btui 138 passed. The allocator-seeding race has a separate regression test (80 runtime/coordination tests passed after the fix). Store recording/sequence/schema tests passed (68), including a held-WAL-writer test on the real worker. API/CLI/Claude/store type checks pass. Only the Claude hosted-options golden changed to request summarized thinking; launch-parity goldens remain unchanged. No local CI lanes were run.

The deployed managed-service `bux -p` check also rendered its user line immediately (first draw rounded to 0 ms). That turn raced preparation: POST 919 ms, warm wait 2478 ms, first partial 5399 ms, and waiting 12091 ms; native-send p95/max was 1.26/11.48 ms. Bundled `bux --version` took 72–99 ms across five samples. A separate cold pre-create exceeded its 5-second deadline under load; these measurements do not certify the cold-launch gate. The live check found a duplicate cold user echo during history catch-up: the fix snapshots history before recording the new prompt and carries its durable sequence into the live echo. Regression tests also cover re-preparing a released process and timing fan-out to multiple subscribers.

Final installed check after the catch-up fix: warm `bux --none` → `ui:spawn` **372.6 ms**, fresh session attached and idle, `btui --version` **0.3.0**, API `/health` **200** with sessions schema 20. A prompted launch took 1027.7 ms, then rendered its user line once before admission completed. Its turn delivered native frames at p95 **1.51 ms**; client/model gap p95 **140.2/138.2 ms**. The separate raw fallback streamed `STREAM_RAW_OK` and exited 0. The six full suites passed; generated OpenAPI/AG-UI checks passed (Swift targets skipped because `BARRY_KIT_DIR` is unset).

## Streaming follow-ups and reliable stop — 2026-10-15

The implementation follows `~/.claude/plans/streaming-followups-and-session-stop.md`.
Feature commits are isolated from the shared master checkout's unrelated staging and edits.
The shared runtime changes were implemented sequentially in one feature worktree so that sequencing,
detached recording and forced cancellation could be verified together. This replaces the proposed two
worktree split; compatible adapter, CLI and native-client changes remain separate commits.

| Item | Change and regression evidence |
|---|---|
| A1 | Foreign resident prompts go through the API inbox and its recording worker. Worker transactions repair collisions in FIFO order, including idempotent retries. Runtime coordination tests cover a writer appending meanwhile; store tests cover the foreign-owner guard, a blocked writer and worker inbox ordering. Corrected replay carries stable `dedupeKey` and an old/new sequence mapping; btui deduplicates it. |
| A2 | Collapsed thinking truncates to terminal columns. `collapsed_thinking_fits_physical_rows` snapshots a 200-character tail at 80 columns. |
| A3 | Catch-up failure releases buffered durable output and schedules one retry. `failed_catchup_releases_live_transcript_and_retries_once` verifies it. |
| A4 | Tool bundles inline the shipped vendor catalog. All four shipped-namespace cases pass; scratch `bag doctor --fix` and `bag build --force sessions/search` both exit 0. SDK workflows pass in the complete SDK suite; fresh-instance registry/help passes after rebuilding the CLI. |
| B1 | The hosted manifest wins over legacy namespace overrides; doctor checks running drift. Hosted sessions default to one aggregate server; inherited identity `namespaceSplit` can opt in. Installation-environment and identity inheritance tests cover the choice. |
| B2 | Warm means `isWarm() === true`, including admission headers and prepare status. Current-turn timings are separate from original preparation data. Runtime and route tests distinguish a live process from an old prepare stamp. |
| B3 | Bench completes without requiring model frames, reports load, and counts only API descendants, including versioned native executables. Socket receipts separate queue wait from callback delay. Bench and socket tests cover these paths. |
| C1 | Stop/remove release residents unconditionally. Accepted message and state queues remain reachable through finalization; reopen refuses before startup cleanup while recording is pending. Blocked-recording runtime tests and archive warning tests cover this. |
| C2 | Pending durable rows remain replayable across turns and after resident removal through read fallback. Runtime replay and WebSocket integration tests cover sequences; GET messages reports pending durability. |
| C3 | Backlog rejection sends its retryable error without recording it. The route regression checks 503 and the nonpersisting send path. |
| C4 | Raw thinking rewrites one dim line and separates the answer. The terminal regression asserts exact escape bytes. |
| C5 | A binary-stat-cached version probe gates `BTUI_SEND`; older clients submit through the CLI. Version and refused-before-spawn tests cover compatibility. |
| C6 | Early subscribe requires exactly 21 URL-safe characters; canonical resolution resubscribes. Wire and attach tests cover it. |
| C7 | Actions generated during the pre-draw drain dispatch before the next wait. Native attach/catch-up tests and the live attach drill cover the path. |
| C8 | Adjacent text blocks join with the same empty separator as streamed deltas. The mapper regression checks `A` + `B` becomes `AB`. |
| C9 | Chunk gaps exclude tool execution and thinking-to-text transitions. Server timer and native timing tests cover this. |
| D | Invalid replay cursors become absent; late old hubs cannot delete replacements; stopped generations cannot enter initialize recovery; hook writes share FIFO; OpenAPI describes 503 as unavailable. SDK timeout text is recognized, idle release emits no phantom event, millisecond environment values are validated, fine-grained streaming stays hosted, effort errors are friendly, effort PATCH retains the warm process, and a new SDK message clears stale timing. Native thinking timers reset, indentation survives paragraph commits, input waits for history, and restored final text does not duplicate an early partial. Direct suites, mapper tests, native behavior tests and generated-contract checks verify these paths. |
| E1 | Shared deadline/abort helpers, bounded owned-process termination and the written Session contract are exported. Deadline tests observe abandoned rejections; the process test kills only its own SIGTERM-resistant child. |
| E2 | The runtime owns cancellation and completion independently of adapter acknowledgement. A 50 ms test forces both an acknowledged-but-silent turn and a hung interrupt, releases the lease and runs the next turn. A silent warm cannot poison the next message; late output and opens are fenced. |
| E3 | Claude close aborts startup/retry; cancellation is logged and bounded. `session interrupt` and `session stop` resolve unique prefixes. Raw and native clients escalate a second Ctrl-C while HTTP is pending, exit 130 after stop and reset escalation per turn. Esc remains a soft interrupt. |
| E4 | Every provider event updates ISO `lastEventAt` with monotonic silence tracking. Listings/live frames expose it; native timing shows prolonged silence. Runtime forced-stop, startup abort, native timing and Ctrl-C tests cover the behavior. |
| E5 | Claude, Codex, OpenCode, Antigravity, Cursor/ACP and Pi all run the same four conformance scenarios and pass their direct suites and typechecks. Launch-parity goldens are unchanged. |

Implementation commits: `9d8b82ab4` (catalog asset), `efd6b492e` (runtime, sequencing and contract),
`424eb48aa` (all adapters), `d6a2f2b59` (CLI), `04aae2067` / `ee041a46b` (detached recording),
`3b010e42b` (replay identity and ACP transport ordering), `25cd70c38` (stable WAL fixture),
`bb2d85e69` (raw stop response race), `5b3c27a6a` / `3c27bf8d9` (control prefixes and independent cancellation).
Native commits `btui-7d8f689` and `btui-a7fa726` are pushed; the final release is installed as btui 0.3.1.

The original `performance/streaming-step-*.json` data is preserved. Their warm labels were based on
older prepare-stamp semantics and are superseded for warm/cold classification. New samples explicitly
record load and use the corrected `isWarm()` definition after deployment.

A fresh before-change sample did **not** reproduce the earlier 12–24 second time-to-request report:
the reused turn recorded 47 ms SDK time to request. Its POST was 46 ms, first partial 900 ms and socket
p95 4.4 ms at load 13.4. That is a loaded observation, not a quiet-machine gate or proof of a namespace
latency gain. The first prepared turn included 1.9 seconds waiting for warm and is labeled separately.

Final measurements and verification: [streaming follow-ups](performance/streaming-followups-2026-10-15.json).

Direct full suites passed sequentially: SDK 2720 (2 skipped), sessions API 785, sessions bag/store 1685
(12 skipped), MCP 459, CLI 1503 (6 skipped), and btui 149. The six adapter suites passed: Claude 138,
Codex 108, OpenCode 73, Antigravity 61, Cursor 50 and Pi 51, including the common cancellation contract.
Subsequent focused checks cover recording finalization/recovery (129 API checks, then 68 runtime checks),
worker sequencing (11), ACP transport ordering (14), mapper timing (5), and CLI controls/terminal/dispatch
(58). Package typechecks and direct lint passed. Generated OpenAPI agrees; Swift generation was skipped
because `BARRY_KIT_DIR` is unset. No local CI lanes ran.

The CLI WAL test originally raced its writer's first read-mark update. Its fixture now primes that
reader before signaling ready; all 12 cases pass with every shared-memory byte assertion retained.
A stale CLI bundle also caused an entry-path check to fail after a source edit; the frozen rebuilt CLI
subsequently passed its full suite.

Installed reused-turn sample, load 9.17: POST 64.7 ms, starting 65.8 ms, first partial 771.7 ms, SDK time
to request 34 ms, socket-send p95/max 1.85 ms. Client/model gap p95 was 681.1/681.4 ms. The first turn
completed after a 16.1-second warm wait. A native three-paragraph reply drew its user line in 0 ms,
streamed 121 chunks/1218 bytes and made 301 draws over 15.1 seconds (20/s). Its socket p95 was 8.3 ms.
A prompted native launch reached `ui:spawn` at 711 ms. Bundled version samples were 125–168 ms.
These loaded observations do not certify the load-below-five gates or establish a namespace latency gain.

Both installed terminals exit 130 when Ctrl-C escalates while interruption is pending. The native first
draw was 1 ms in that stop drill. Live verification exposed and fixed raw mode's waiting-before-stop-HTTP
exit-code race, and the CLI's prefix lookup in its shared ownership hook. A real Claude interrupt that
never completed was forced at the ten-second runtime deadline; the next message succeeded on a fresh
harness. CLI stop released the resident with no error frames and a fully durable transcript (21 rows).
Its first loaded end-to-end duration was 1.39 seconds, including CLI startup; the API handled stop in
75 ms. A later loaded CLI sample was 5.32 seconds with an 86 ms API handler. Cancellation now skips model
setup so a damaged or slow model catalog cannot prevent it.

API and MCP were rebuilt/restarted from master, and all 70 bag bundles rebuilt. The API's installed
namespace flag is `false`. Cold module loads and host paging initially blocked health/launch attempts;
one API restart required an explicit start. Those failed attempts are retained in the measurements.
The original staged patch remains byte-identical, all non-overlapping edited files retain their hashes,
and the two overlapping working files retain the user's edits alongside the feature additions.

The refreshed live MCP drill used the deferred `send_message` tool through `call_tool` (the current
name for the plan's `send_prompt`). It reached `/prompts/enqueue` with HTTP 200 in 318 ms, was delivered
through the resident inbox, completed the stream without error frames or new sequence conflicts, and
stopped with HTTP 200. An earlier MCP process still held a stale bundle despite background rebuilding:
its one sequence conflict recovered with the explicit mapping and no transcript loss. Rebuilding all
70 bags **before** restarting MCP is part of this deployment, so the cached implementation is live.
The final entry-path checks pass after rebuilding; the no-prompt launch probe could not certify its
latency gate under the current host pressure. Quiet-machine certification remains outstanding; no code
items or adapter conformance cases are deferred.

The final native regression also defers an early inactive handshake to the attached record:
`early_inactive_handshake_defers_to_the_attached_record` covers pending and completed records and
submitting from each. All 149 native tests and the release rebuild pass. The installed fresh no-prompt
client reached ready and exited 0; `ui:spawn` was 1147.5 ms at load 5.42, so the 500 ms gate remains
unmet in this sample. All throwaway residents were stopped and their harness children checked absent.

## Verification follow-through — 2026-10-15

Swift verification is complete. `BarryKit-0ff4e2e` is pushed on its master branch. The current OpenAPI
spec and AG-UI fixture checks compare both repositories without skipping Swift; all 24 Swift tests
pass in an isolated worktree with two build jobs. New decode tests cover forced-stop outcomes with
`recordingPending` and present/null/missing `lastEventAt`. Regeneration exposed an older handwritten
wrapper that still used numeric bound IDs: `updateBound(name:request:)` now matches the current
named-bound API. This supersedes the earlier Swift-skip limitation.

Performance verification is being recorded separately in
[streaming verification](performance/streaming-verification-2026-10-15.json), preserving the original
measurements. The quiet gate requires host load below five; loaded rows are not quiet certification.

The live verification uncovered one native regression missed by the earlier attach test: an inactive
handshake preceding history was treated as ready, but sending no longer resubscribed after the API
admitted a resident. The server completed the reply while the UI remained starting. `btui-b0d137e`
tracks resident subscription separately from phase. The expanded regression tests admission,
resubscription, visible delivery exactly once, and an ordinary next turn without resubscribing. All
149 native tests and the release build pass. Three installed fresh prompted sessions then completed
with first draw 0 ms and 20.4/21.5/23.7 draws per second.

The additional loaded measurements include a 523 ms CLI stop and warm SDK time-to-request of 172/9/9 ms.
Socket-send p95 was 11.72/82.96/0.85 ms, so the loaded rows are mixed rather than blanket passes. One
repeated native attach encountered HTTP 429; its failure is retained. The quiet-window monitor records
host load throughout; samples above five do not certify the quiet gates.

A one-minute-load-below-five window produced a warm server turn with POST 65.5 ms, starting 68.6 ms,
socket-send p95 0.86 ms and maximum 4.50 ms. Model/client gap p95 was 87.16/87.93 ms. Bundled version
samples were 165/70/80 ms. The later native launches ran after load rose above five and took
614–841 ms; they do not certify the 500 ms quiet launch gate.

Evidence limits remain explicit: Claude `init.tools` counts by trait selection have not been captured;
no causal namespace latency gain is claimed; the long retention probe sent activity heartbeats;
live draw rates are whole-turn averages, with the strict cap covered by pacing tests; and the workflow
and first-run suites passed without a separately recorded quiet-machine rerun.

The final four-minute individual-gate watch never reached load below five. It ended at load 9.26 and
stopped its last owned probe with HTTP 200. Quiet launch and stop certification remains open; the
523 ms loaded stop is a numeric pass, while another loaded stop took 1043 ms. API/MCP health passed,
the namespace flag is `false`, and OpenAPI plus AG-UI fixture checks compared the canonical Swift
repository without skips. No unrelated workloads or sessions were stopped.
