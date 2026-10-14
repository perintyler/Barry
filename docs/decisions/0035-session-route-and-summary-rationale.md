# ADR 0035: Session route ownership and summary scheduling

## Current invariants

Read routes belong to sessionsRouter. Lifecycle routes pair tool results by explicit ids, preserve channel provenance and report actual listener guarantees. Creating without a prompt supports subscribing before startup. Actions own action-run persistence; API health uses the session-store client seam. Summary sweeps preserve progress with a durable watermark and check admission before each sequential model call. Test sessions buffer every pushed event and drain before close.

## Preserved source observations

The following comments record their original observations. Historical counts and migration descriptions are retained as evidence, rather than presented as current verification.

### Original comment 1: bags/sessions/api/src/routes/session-lifecycle.ts

```ts
// NOTE: GET /sessions/ and GET /sessions/:id are served by sessionsRouter, which
// is mounted before this router (see index.ts). The list/get handlers that used
// to live here returned a divergent {session} shape and were permanently shadowed —
// removed so router mount order is no longer load-bearing for these paths.
//
// `GET /check-git` was removed for the same reason, having survived that sweep by
// sitting a few lines above this note. It was shadowed by `GET /:id` in
// sessionsRouter and had been unreachable for its whole life: a request for it
// answered `{"title":"Session not found"}` from the member handler, which had
// read "check-git" as a session id. Nothing called it — nothing COULD have, and
// no caller existed in this repo, any bag or any UI.
//
// It is not reinstated above sessionsRouter, because the question it asked is one
// sessions no longer ask: a session runs in a WORKING DIRECTORY, which does not
// have to be a git repository (see validateRepoPath, `cb7609e2`).

```

### Original comment 2: bags/sessions/api/src/routes/session-lifecycle.ts

```ts
    // The capture-channel probe that stood here has ANSWERED and is removed.
    //
    // 736 lines over one api lifetime, every one `channel:"hook"` (620
    // tool_call, 116 text) and none NULL — which is its own decision table's
    // second branch: origin is correct HERE and anything lost is lost
    // downstream. So this route is exonerated; do not re-probe it.
    //
    // The NULL rows that remain are a DIFFERENT and deliberate thing:
    // `messages.ts:288-295` returns NULL when a caller genuinely does not know
    // its channel, because a defaulted value would make "captured before
    // provenance existed" indistinguishable from "captured over the engine".
```

### Original comment 3: bags/sessions/api/src/routes/session-lifecycle.ts

```ts
      // toolUseId lets a later call attach the result to this row. Hooks that
      // fire before a tool runs (PreToolUse) have no result yet, and without an
      // id there is nothing to match on — the row stays result-less forever.
      // Fall back to a fresh id when the caller supplies none, so an inline
      // result still pairs deterministically instead of via FIFO. (It used to
      // be derived from the row's sequence, which the store now assigns only
      // as the row is inserted.)
```

### Original comment 4: bags/sessions/api/src/routes/session-lifecycle.ts

```ts
/**
 * POST /sessions — create a session, and start it when `prompt` is supplied.
 *
 * Was `POST /sessions/draft`. There is no draft session any more: the name gave a
 * lifecycle state its own sub-resource, and made "create a session" impossible to
 * express without it.
 *
 * With `prompt`: the row is created and the prompt is sent, so one call does what
 * two used to. Without it: the row is created and nothing runs — still a real
 * need, because `POST /actions/trigger` hands back a session id and prompt text
 * WITHOUT sending it so the caller can subscribe to the session socket before the
 * agent emits anything. Starting eagerly there would drop the first output.
 */
```

### Original comment 5: bags/sessions/api/src/routes/session-lifecycle.ts

```ts
        // What will actually happen to it, from the session's live listeners:
        // a driver with a registered surface wakes now, one without reads this
        // on its next Barry tool call. This route used to assert the latter for
        // everyone (.1 invariant 4).
```

### Original comment 6: bags/sessions/api/src/app.ts

```ts
    // Probes the SESSION STORE, which is what this API actually reads.
    //
    // This ran `db.selectFrom("sessions")` against the old store. Migration 041
    // dropped that table, so every /health request errored the query, reported
    // `dbConnected: false`, and left a `relation "sessions" does not exist` line
    // in the database log — a health check failing on a database the API no
    // longer uses, while the store it DOES use went unchecked.
    //
    // Through the seam, so it follows whichever backend is serving.
```

### Original comment 7: bags/sessions/api/src/routes/actions.ts

```ts
// action_runs left the old store for the actions bag's own SQLite store; the
// exported surface is unchanged, so this is an import path and nothing else.
```

### Original comment 8: bags/sessions/api/src/session-summarizer.ts

```ts
/** Quiet this long before a session is summarized: the old debounce, as a sweep condition. */
```

### Original comment 9: bags/sessions/api/src/session-summarizer.ts

```ts
/**
 * One sweep: summarize every session that fell quiet after new messages, up to
 * `maxSessions`, one at a time.
 *
 * Replaces a 15-minute debounce timer per session in the API process. Timers
 * died with the process and fired back-to-back across sessions; a sweep keeps
 * its place in a durable watermark (`summary_watermark_seq`), and running the
 * summaries sequentially in one process means one model load serves them all —
 * which is what the old process-wide interval was approximating.
 *
 * The memory admission (summary-admission.ts) is checked before each model
 * call: the model is wired, and the machine's state now is what matters.
 */
```

### Original comment 10: bags/sessions/api/src/test-helpers/fake-session.ts

```ts
/**
 * A harness session a test drives by hand.
 *
 * Nothing happens until the test says so: `push` sends one event, `end` ends
 * the current turn. That is what lets a test tell "still running" from "has
 * finished" rather than inferring it from a call count a synchronous side
 * effect could satisfy either way.
 *
 * Events pushed before anyone reads are kept, not dropped — two pushes in one
 * tick used to lose the second, and a test then "passed" only because the
 * event it asserted on never reached the runtime.
 *
 * Closing follows the contract a real hosted session keeps: a turn in flight
 * streams to its `done` first (the harness draining after it was told to
 * stop), and `close` resolves only then.
 */
```

