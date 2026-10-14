# ADR 0034: adapter builds, capture and relay rationale

Status: accepted

## Context

Adapter comments and capture/delivery tests used private invariant and work-plan
labels. Their complete original text is preserved below. This record describes
the meaning reconstructed from the current code; it does not reconstruct or claim
possession of the original private research or planning artifacts.

## Decision

Keep current build, capture and relay invariants beside their implementation or
assertion and link this tracked record. Resolve labels only from explicit current
Markdown definitions; frozen review evidence and fenced historical examples do
not declare active labels. Keep the existing credential invariant declared in the
adapter README. Do not edit main.ts during the current hot-path freeze.

## WP-C4: installation-owned adapter selection

The existing CLI comment names the adapter add/remove/list group. Installation
selection is read from the adapter registry rather than inferred from sibling
packages. This is a tracked explanation of that label in the current source,
not a claim about unavailable original work-plan text.

## WP-B4: tracking and turn-end relay hooks

The existing CLI hook wiring records vendor events and supplies a queued-message
callback at turn end. The label refers to this relay responsibility, with the
adapter's actual delivery limits remaining authoritative. This record makes the
frozen main.ts comments retrievable without changing the hot path.

## Consequences

Source comments outside the frozen entry file use plain current invariants and a
concrete ADR link. The legacy unused permission predicate is identified honestly
until its separately tracked SDK-lane removal. No executable behavior, inventories,
authorization, fixture assertions or engine lifecycle changes in this move.

## Original rationale: adapters/sessions/antigravity/src/hooks.ts

```text
/** Setup tracking relay hooks for Barry session tracking (AP-09). */
```

## Original rationale: adapters/sessions/antigravity/src/live/antigravity-live.test.ts

```text
// Honest delivery reporting (AP-08): deliver fails when workspace is removed
```

## Original rationale: adapters/sessions/claude/src/anthropic-compatible/env-defaults.ts

```text
/**
 * Env vars the bundled claude CLI reads that silence nonessential features,
 * with the values barry wants by default.
 *
 * Every named gate was rechecked with strings on the bundled native 2.1.282
 * binary (`@anthropic-ai/claude-agent-sdk@0.3.282`, darwin-arm64). All remain
 * present; the descriptions below retain the earlier implementation reading:
 *
 * - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` — presence gate. Covers
 *   telemetry, error reporting, the `/bug` command, changelog and client-data
 *   downloads, and the fast-mode status prefetch. It is the broad form; the
 *   narrower `DISABLE_TELEMETRY` / `DISABLE_ERROR_REPORTING` /
 *   `DISABLE_BUG_COMMAND` vars each gate a subset of the same traffic.
 * - `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` — compared against the exact string
 *   `"false"`. Beyond the suggested-next-prompt model calls it also gates the
 *   memory-extraction side call that shares the branch, for both the
 *   interactive (`repl_main_thread`) and `sdk` query sources.
 * - `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` — presence gate, checked before the
 *   `includeGitInstructions` setting. Trims the built-in commit/PR workflow
 *   instructions from the system prompt; barry sessions carry their own commit
 *   discipline via instructions and bags, so the preset text is duplicate
 *   tokens.
 *
 * - `DISABLE_AUTOUPDATER` — stops the binary replacing itself at startup.
 *   Invariant I9: a mode's guarantees are verified against a BUILD, so a
 *   session running on a binary that updated underneath it has guarantees
 *   nobody checked. The SDK path has always set this unconditionally; the TUI
 *   launch did not, so `barry start --claude` on a native install self-updated
 *   under Barry and nothing reported it.
 *
 * Applied fill-if-absent everywhere: a user who sets one of these explicitly
 * in the session env wins over the default. NOT here: the prompt-caching
 * controls — caching stays on, it saves tokens.
 */
```

## Original rationale: adapters/sessions/codex/src/app-server/host.ts

```text
/**
 * Assert the engine is the build this adapter's guarantees were verified on.
 *
 * Invariant I9. The app-server exposes NO protocol version and its schema is
 * version-specific, so there is nothing to negotiate — the only safe move is to
 * compare the build and declare the session unverified when it differs.
 * Returns the observed build rather than throwing: a mismatch marks the
 * session, it does not refuse to run it.
 */
```

## Original rationale: adapters/sessions/codex/src/transcript.ts

```text
/**
 * Reading codex's rollout jsonl.
 *
 * **Backfill only, and increasingly so.** The rollout is still written, but the
 * vendor now labels it "legacy" beside a `thread_history_1.sqlite` projection —
 * a format change of exactly the kind learning L6 warns about. And once Barry
 * hosts a codex session (WP-B2) there is nothing to read here at all: the
 * app-server stream carries everything, and no file is read for a hosted
 * session.
 *
 * So this exists for one case: a codex session Barry did NOT host, whose
 * rollout is the only record. It is expected to stop working; the coverage
 * counters are how that becomes visible.
 *
 * Barry already owns `CODEX_HOME` per session (learning L8), so for a
 * Barry-launched guest the file is somewhere Barry chose — which is why
 * `locate` reads the session's recorded home rather than guessing at the
 * user's.
 */
```

## Original rationale: bags/sessions/api/src/routes/otlp.ts

```text
// A claude session Barry never launched, or one whose provider id has
      // not been linked yet. COUNTED rather than dropped silently — a
      // receiver seeing traffic it cannot place is a real condition, and
      // WP-D3 (foreign guests) is what turns these into sessions.
```

## Original rationale: bags/sessions/src/capture/transcript-watcher.test.ts

```text
// After WP-C4 a deployment ships only the adapters its user installed, so
    // "no reader for cursor" is an ordinary state.
```

## Original rationale: bags/sessions/src/capture/transcript-watcher.ts

```text
/**
 * Sweeping guest sessions' transcripts.
 *
 * The one job: for each session Barry did NOT host, find its transcript, read
 * what is new, and persist it — idempotently, so a sweep that runs every minute
 * over a growing file costs nothing after the first pass.
 *
 * **It never reads a hosted session's file.** A hosted session captures from
 * the engine, so reading its transcript would duplicate what is
 * already stored and, worse, make the engine's completeness look like the
 * transcript's. The skip is explicit rather than incidental.
 *
 * The counters are not decoration. A broken reader and a quiet agent both
 * produce no rows, and the only way to tell them apart is to count what was
 * ATTEMPTED beside what was stored — see `./coverage.ts`, which turns those
 * counts into the two alerts worth raising.
 *
 * The adapter is resolved through an INJECTED resolver: this bag may not name
 * an adapter, and after WP-C4 which adapters exist is a user's
 * install choice rather than a constant.
 */
```

## Original rationale: bags/sessions/src/capture/transcript-watcher.ts

```text
// Not an error: after WP-C4 a deployment ships only the adapters its
      // user installed, so "no reader for cursor" is an ordinary state.
```

## Original rationale: bags/sessions/src/delivery/matrix.test.ts

```text
// Invariant I6: a human gate on a machine-to-machine delivery is a failure
    // regardless of what the cell declares.
```

## Original rationale: bags/sessions/src/delivery/matrix.ts

```text
/**
 * Judge one cell.
 *
 * The three things every cell must satisfy, whatever it declares:
 *  1. the REPORT matches the declaration — this is the actual requirement, and
 *     a cell that cannot wake passes by saying so;
 *  2. a cell that claimed a wake produced one;
 *  3. no dialog appeared, ever. Invariant I6: a human gate on a
 *     machine-to-machine delivery is a failure regardless of guarantee.
 */
```

## Original rationale: bags/sessions/src/delivery/report-engine.test.ts

```text
/**
 * What a sender is told when the recipient's engine has died.
 *
 * WP-B0 acceptance 2. The failure this prevents: a hosted session's listener
 * registration outlives its engine by up to a heartbeat, so between the engine
 * being `kill -9`'d and the registration lapsing, a sender would be promised a
 * `wake` that nothing can deliver. `on-resume` is the accurate answer — the
 * message is held and arrives when the session comes back.
 */
```

## Original rationale: bags/sessions/src/engines/engine-outlives-starter.test.ts

```text
/**
 * An engine outlives the terminal that started it.
 *
 * This is the load-bearing claim of WP-B0: closing a TUI must not end the
 * conversation, because continuing that session from the phone is the feature.
 *
 * Getting a test that can FAIL took two tries, and both failures looked like
 * passes:
 *
 *  1. Testing from inside vitest proves nothing — the test process never dies,
 *     so `detached: true` can be deleted and every assertion still passes.
 *     (Verified: it was, and they did.)
 *  2. Testing that the engine is reparented to pid 1 also proves nothing: a
 *     child is reparented whenever its parent exits, detached or not.
 *
 * What `detached` actually changes, measured: the child gets its OWN PROCESS
 * GROUP. That is the mechanism. A closing terminal does not politely wait for
 * its children — it signals the whole foreground process group, and a child
 * sharing that group dies with it. A child in its own group never receives it.
 *
 * So these assert group membership, and the control genuinely fails.
 */
```

## Original rationale: bags/sessions/src/engines/engines.test.ts

```text
// Invariant I9: a session's guarantees were verified against a build, so
    // the build a live engine is actually running has to be recorded to be
    // comparable.
```

## Original rationale: cli/src/commands/hook.test.ts

```text
/**
 * Delivery is the half that makes this the RELAY WP-B4 asks for, not just a
 * recorder: cursor's `stop` hook accepts a `followup_message` and starts a
 * fresh turn with it, which is the only moment a vendor takes a prompt nobody
 * typed. That is the `turn-end` guarantee, and it is why a message to a
 * guest-plus session lands after the agent's next reply.
 */
```

## Original rationale: cli/src/main.ts

```text
// ── Adapters ──────────────────────────────────────────────────────────────────
// `barry adapter doctor`, not `barry doctor`: the root `doctor` is identity
// health and `bag doctor` is bag health, so this follows the same shape. The
// group is also where WP-C4's add/remove/list land.
```

## Original rationale: cli/src/main.ts

```text
// Delivery, at turn-end only. This is what makes the hook the RELAY
        // WP-B4 asks for rather than a pure recorder.
```

## Original rationale: decide-permission.ts (removed from sdk/src/bounds in review step 13)

```text
/**
 * Ruling on a native tool call, for every adapter.
 *
 * Invariant I6, in order: **the bound's deny rules go to the engine first** (so
 * no request is emitted at all), **Barry's callback answers second** (for
 * whatever the engine still asks about), and **a human dialog never**. Approvals
 * are not a Barry primitive.
 *
 * The two halves are not interchangeable. An engine-level rule is better
 * because the call never happens and no client shows a dialog; a callback is
 * what covers everything a vendor's rule language cannot express. Every adapter
 * has both, in different spellings — opencode `permission` rules, codex's
 * sandbox mode and approval policy, claude's `disallowedTools`, cursor's
 * `cli.json` — which `boundToEnginePolicy` translates per adapter.
 *
 * This file is the SECOND half: one `decide` every adapter's `host()` hands its
 * permission requests to. It reuses the same predicates the MCP engine's
 * call-time guards use (`../bounds/bound-guards`, `bash-classifier`) rather than
 * restating them, because two implementations of "is this path denied" is how a
 * session gets refused by one and allowed by the other.
 */
```
