# ADR 0033: tracked capture and transport rationale

Status: accepted

## Context

Source comments cited untracked research, rulings and review labels with several
spellings. Those labels do not provide readers a retrievable design record. The
comments contain useful explanations for transport admission, connection leases,
retry cooldowns, memory reads, transcript streaming, capture, delivery and sweeps.

## Decision

Keep the controlling current invariant in each source comment and link this
tracked ADR. Preserve each complete original explanation below, including its
historical labels, measurements, caveats and regression motivation. Extend the
reference check to recognize the actual citation spellings found in the tree.
Do not change executable behavior in the rationale move.

## Consequences

Readers can retrieve the historical evidence without treating an untracked label
as an authoritative current dependency. Existing tests and production logic stay
unchanged. Historical manual observations remain historical; this document does
not claim a fresh reproduction of every observation it preserves.

## Original rationale: adapters/sessions/claude/src/hosted/live-session.ts

```text
/**
 * claude hosted, live: one streaming Agent SDK query holds the conversation
 * across turns, with Barry as its only client.
 *
 * The query's prompt is an async iterable that stays open, so a message can
 * be yielded into the turn that is running (the SDK folds it in before the
 * next tool call, research E8); the SDK's own interrupt stops a turn and
 * leaves the conversation alive; and every tool call is ruled
 * by Barry in the PreToolUse hook before it runs.
 *
 * The process is a means, not the session: it is closed after a quiet spell
 * and opened again, resuming the same conversation id, by the next delivery.
 * One that dies ends its turn with an error rather than leaving it open.
 *
 * A turn that asks for structured output runs one-shot instead, as the
 * per-turn path runs it: the query's output format is fixed when it opens.
 */
```

## Original rationale: adapters/sessions/codex/src/modes.ts

```text
/**
 * What codex can do today, and what proved it.
 *
 * Codex's TUI is always an app-server client, so `codex app-server --listen`
 * plus `codex resume <id> --remote` puts the real TUI on an engine Barry owns
 * (research E2/E5). Hosted is that engine, driven by
 * `hosted/app-server-session.ts`; instrumented attaches the TUI to it. Guest is
 * the TUI on its own embedded engine in a private `CODEX_HOME`.
 *
 * Every mode runs on the identity's OPENAI_API_KEY through a provider Barry
 * declares in that home (`runtime.ts`).
 */
```

## Original rationale: bags/filesystem/tracker/src/changes.test.ts

```text
/**
 * astra review SR2: `GET /changes` had no upper bound on `limit` (a client
 * could ask for an unbounded scan of an append-only, ever-growing table) and
 * `parseInt(...) || 50`-style validation didn't reject a negative limit —
 * only NaN/falsy. Listings also returned every row's `diff` body, which
 * nobody rendering a list actually needs.
 */
```

## Original rationale: bags/mcp/src/application.ts

```text
// Connect credentialless bags eagerly, bounded to 5 concurrent — an
      // unbounded Promise.all here fires every bag's stdio spawn / OAuth
      // handshake / HTTP connect in the same instant, a CPU/FD/network burst at
      // startup with dozens of bags (astra review F11; see bag-proxy.ts's
      // mapWithConcurrency for the timing budget this bound is sized against).
```

## Original rationale: bags/mcp/src/application.ts

```text
// Which pool connection keys each MCP session references (for pruning) —
  // pre-connect leases, not a plain post-hoc record; see connection-leases.ts
  // for why the distinction matters (astra review F9-F11).
```

## Original rationale: bags/mcp/src/application.ts

```text
// Bounded for the same reason as loadBagPool's eager connect — this
        // path runs on every session init that still needs a recovering bag,
        // so an unbounded fan-out here repeats the startup burst at session-
        // init cadence instead of just once (astra review F11). retryConnect's
        // own per-key cooldown (bag-proxy.ts) already skips a still-failing
        // bag's 45s timeout on repeat calls; this bounds the concurrency of
        // whichever bags in this batch DO attempt a real connect.
```

## Original rationale: bags/mcp/src/application.ts

```text
// Prune pool connections no longer referenced by any active session.
      // activeKeys() includes both committed ownership AND still-pending
      // reservations, so a connection mid-establishment is protected for the
      // ENTIRE window between reserve() and commitOwnership()/release() —
      // guaranteed to run exactly once each, on every code path, the same
      // try/finally pattern admitTransport's reservation uses (astra review
      // F9-F11; see connection-leases.ts and the two /mcp route handlers).
```

## Original rationale: bags/mcp/src/bag-proxy.test.ts

```text
/**
     * Astra review F11: index.ts's lazy-connect path calls retryConnect on
     * EVERY session init that still needs a failed/needs-auth/auth-expired
     * bag — without a cooldown, a persistently broken bag pays the full
     * CONNECT_TIMEOUT_MS on every single initialize, for every session,
     * until it recovers.
     */
```

## Original rationale: bags/mcp/src/bag-proxy.test.ts

```text
/**
     * Astra review F9-F11: the actual regression this pool-level fix closes.
     * index.ts's caller-supplied `activeKeys` only reflects transports that
     * finished registering — a transport still mid-initialize (past its own
     * connect, not yet at registerTransport) looks completely unreferenced
     * to a sweep that fires in that gap. Without the grace period, THIS test
     * would show connectionCount going to 0 immediately.
     */
```

## Original rationale: bags/mcp/src/bag-proxy.test.ts

```text
// mapWithConcurrency (astra review F11)
```

## Original rationale: bags/mcp/src/bag-proxy.ts

```text
/**
 * How long a freshly-connected pool key is protected from `pruneUnused` even
 * if absent from its caller-supplied `activeKeys` set — longer than
 * index.ts's 60s sweep interval so a single sweep tick landing right after a
 * connect can never see the key as prunable before the owning transport has
 * had a full sweep cycle to finish registering it (astra review F9-F11).
 */
```

## Original rationale: bags/mcp/src/bag-proxy.ts

```text
/**
 * Bounded-concurrency map, preserving input order in the result array.
 *
 * Astra review F11: `loadBagPool`'s eager-connect fan-out and the lazy-connect
 * retry path both fire every bag's connect at once via `Promise.all` — with
 * dozens of bags that means every stdio spawn / OAuth handshake / HTTP
 * connection attempt starts in the same instant, a CPU/FD/network burst at
 * startup (and, for the retry path, at every session init that needs a
 * recovering bag). Bounding fan-out to 5 concurrent connects keeps worst-case
 * wall time well inside session-resolve-cache's 10-minute pending deadline:
 * even if every single bag times out at CONNECT_TIMEOUT_MS (45s), 5 workers
 * each clear floor(600s / 45s) = 13 full timeouts before the 10-minute mark,
 * i.e. up to 65 fully-failing bags before a caller's cache entry could expire
 * mid-resolution — comfortably above any real bag count. A real connect
 * succeeds in milliseconds, so this bound only bites when bags are actually
 * failing/unreachable, not in the normal case.
 *
 * Uses a bounded worker pool
 * (a worker-pool pattern: N workers pulling from one shared index) — not
 * imported from there because the two packages don't share a runtime
 * dependency on each other, and this is a small enough pure function that
 * duplicating it beats adding one.
 */
```

## Original rationale: bags/mcp/src/bag-proxy.ts

```text
/**
   * Per-key cooldown after a failed connect attempt (ms epoch until which
   * retries are skipped). Astra review F11: `retryConnect` is hit from
   * index.ts's lazy-connect path on EVERY session init that needs a
   * still-failing bag — with no cooldown, a bag that is down or misconfigured
   * pays the full CONNECT_TIMEOUT_MS (45s) on every single initialize, for
   * every session, until it recovers. 60s is short enough that a real
   * recovery (auth completed, service back up) is picked up quickly, long
   * enough that a churn of session inits (the ~15min-reconnect pattern
   * transport-slots.ts documents) doesn't re-attempt a known-broken bag more
   * than once or twice a minute.
   */
```

## Original rationale: bags/mcp/src/bag-proxy.ts

```text
// A prior attempt on this exact key failed recently — skip paying
    // CONNECT_TIMEOUT_MS again until the cooldown clears (astra review F11).
```

## Original rationale: bags/mcp/src/bag-proxy.ts

```text
// index.ts calls this on EVERY session init that still needs a failed/
    // needs-auth/auth-expired bag — without a cooldown a persistently broken
    // bag pays CONNECT_TIMEOUT_MS on every single initialize (astra review
    // F11). clearCooldown() lets a completed `bag auth` or manual retry skip
    // the wait.
```

## Original rationale: bags/mcp/src/bag-proxy.ts

```text
/**
   * Close connections not referenced by any active session.
   *
   * A key absent from `activeKeys` is prunable UNLESS it connected within
   * the last `CONNECTION_SETTLE_GRACE_MS` — the caller's `activeKeys` only
   * reflects sessions that finished registering (index.ts's
   * registerTransport), which runs well after this pool already cached the
   * connection. Without the grace period a sweep landing in that window
   * would close a connection moments after opening it, for the transport
   * that is the only reason it exists (astra review F9-F11).
   */
```

## Original rationale: bags/mcp/src/session-resolve-cache.test.ts

```text
/**
   * Astra review F10: the pending-never-expires gap.
   *
   * A resolution that takes longer than SESSION_RESOLVE_TTL_MS to settle
   * (DB lookups, credential resolution, bag connects can all be in the
   * critical path) used to have its cache entry expire WHILE STILL PENDING,
   * because `isCacheEntryUsable` checked every entry — settled or not —
   * against the same short clock measured from `at` (creation time). A
   * second transport initializing under the same trait key just after that
   * would see the entry as unusable and kick off a SECOND resolution in
   * parallel with the first, defeating the single-flight collapse this cache
   * exists for.
   */
```

## Original rationale: bags/mcp/src/wiring.test.ts

```text
/**
 * Astra review F9: admission reservations must actually be released on every
 * path, not just the happy one — index.ts's admitTransport()/registerTransport()
 * wiring can't be exercised directly (both routes build their servers inside a
 * request handler), so this pins the SOURCE STRUCTURE the fix depends on: a
 * `try { ... } finally { pendingAdmissions.release(admissionId) }` wrapping the
 * whole initialize block. A future edit that "simplifies" this back to a plain
 * `if (!admitTransport(...))` check (dropping the reservation id and its
 * release) would compile fine and pass every OTHER test in this suite — the
 * TOCTOU window PendingAdmissions closes (see transport-slots.ts) would just
 * silently reopen. transport-slots.test.ts proves PendingAdmissions itself is
 * correct; this proves index.ts still calls it the way that correctness
 * depends on.
 */
```

## Original rationale: bags/memory/src/store.test.ts

```text
// astra review SR1: the query pattern changed (compact preview first, full
  // body+tags only for always-mode rows) but the CONTENT must not — every
  // field `injection.ts` actually reads has to come out identical to what a
  // naive "fetch everything" implementation would produce.
```

## Original rationale: bags/memory/src/store.ts

```text
/**
 * What a session starting in `repo` should see: always-mode bodies plus an
 * index of the rest. Repo-scoped rows and globals, never archived ones.
 *
 * Two-phase on purpose (astra review SR1): `injection.ts` only ever needs
 * the FULL body for `always`-mode entries (`renderAlways` renders the whole
 * thing, up to its own char budget) and only ever needs a short preview for
 * `index`-mode entries (`renderIndex` calls `firstLine`, which reads at most
 * 120 chars). It never reads `tags` for either. The old single query fetched
 * every candidate row's full body via `SELECT *` and hydrated tags for all
 * of them — paying to fetch and transmit content that `index` entries (often
 * the majority, since `always` is meant to stay small) never use.
 *
 * Phase 1 fetches compact metadata + a bounded preview for every candidate
 * row, no tag hydration. Phase 2 fetches full bodies + tags only for the
 * rows that turned out to be `always`-mode — never for `index` rows, which
 * is where the real read savings are on a scope with many on-demand
 * memories and few always ones.
 */
```

## Original rationale: bags/sessions/api/src/routes/transcript-stream.test.ts

```text
// astra review SR4 bug 2: no in-flight guard meant two overlapping ticks
  // could both read from the same starting offset and double-send.
```

## Original rationale: bags/sessions/api/src/routes/transcript-stream.test.ts

```text
// astra review SR4 bug 4: the old code advanced its tracked offset once,
  // after the whole per-tick loop finished, not per line as entries were
  // actually sent.
```

## Original rationale: bags/sessions/api/src/routes/transcript-stream.test.ts

```text
// the second entry must never have been written
    // astra review SR4 bug 4: sentThrough must reflect exactly what was
    // sent — the first line's byte length — not 0 (which would resend line
    // 1 on a hypothetical next tick) and not the full file size (which
    // would skip line 2 forever, since it was never actually sent).
```

## Original rationale: bags/sessions/api/src/routes/transcript-stream.test.ts

```text
// astra review SR4 bug 3: res.write's return value was ignored — no
  // backpressure. A write that doesn't fully flush must wait for `drain`
  // before the tick's loop proceeds to the next entry.
  //
  // The first version of this test polled on `writes.length` reaching 1,
  // then asserted it hadn't reached 2 yet. That did NOT discriminate a
  // missing backpressure implementation: run as a negative control (strip
  // `writeEntry`'s drain-await entirely), the test stayed green, because
  // `for await` over the fake async generator crosses enough real microtask
  // boundaries on its own that the poll loop's `await Promise.resolve()`
  // calls gave the second write time to happen anyway — nothing in the test
  // ever depended on `drainNow()` actually being called to make progress.
  // Fixed by asserting on `onDrain` actually being REGISTERED (proof the
  // code path ran) and on the tick's promise remaining unsettled specifically
  // BECAUSE `drainNow()` hasn't fired yet (checked via `hasSettled`, not via
  // write-count polling).
```

## Original rationale: bags/sessions/api/src/routes/transcript-stream.test.ts

```text
/**
 * A fake `SseConnection` that records the ORDER of operations, so the
 * close-before-initial-send claim (astra review SR4 bug 1) is checked
 * behaviorally rather than by re-reading the source.
 */
```

## Original rationale: bags/sessions/api/src/routes/transcript-stream.ts

```text
/**
 * astra review SR4: the SSE transcript stream had four bugs, all correctness
 * issues before they're performance ones:
 *
 * 1. The client-disconnect cleanup (`req.on("close", ...)`) was registered
 *    AFTER `await sendNewEntries()` for the initial replay. A client that
 *    disconnects during a slow initial send (a large transcript) has no
 *    listener armed yet — the `setInterval` this function starts is never
 *    torn down for that connection, leaking a timer per abandoned request.
 * 2. `setInterval(sendNewEntries, 1000)` had no in-flight guard. If a tick
 *    takes longer than 1000ms (slow disk, a large new chunk), the next tick
 *    fires while the previous is still reading — two concurrent reads can
 *    race on the same tracked byte offset.
 * 3. `res.write(...)`'s return value was ignored — no backpressure. A slow
 *    client's socket buffer fills and writes queue up in process memory
 *    with no bound.
 * 4. The tracked byte offset advanced once, after the whole per-tick send
 *    loop finished — not incrementally as lines were actually sent. Since
 *    (2) allowed overlapping ticks, two ticks could both compute new
 *    entries against the SAME pre-tick offset and double-send.
 *
 * This module owns the pure/injectable parts of the fix so they're testable
 * without spinning up a real Express server or a real timer: `TranscriptTail`
 * tracks one connection's read position and in-flight state; `StreamPort` is
 * the I/O the caller injects (real fs/net in the route, fakes in tests).
 */
```

## Original rationale: bags/sessions/api/src/routes/transcript-stream.ts

```text
/**
 * Cap on entries returned by the non-SSE JSON fallback (astra review SR4).
 * That path previously read and returned the ENTIRE transcript in one
 * response regardless of size; a long-running session's transcript could be
 * tens of thousands of entries. `?limit=` (capped here) lets a client bound
 * the response; `?before=<index>` pages backward through the rest.
 */
```

## Original rationale: bags/sessions/api/src/routes/transcript.ts

```text
// Return the transcript as JSON, paginated (astra review SR4): the old
    // unconditional full-file read/return sent the ENTIRE transcript over
    // the wire regardless of size. `before` pages backward from the newest
    // entry (or from a given 0-based index) toward the oldest; omit it for
    // the first, most-recent page.
    //
    // This still parses the whole file per request — real pagination that
    // skips reading the front of a huge transcript would need a byte-offset
    // index (the same approach the SSE side's `TranscriptTail` already uses
    // for incremental reads, just persisted across requests instead of one
    // connection). That's a larger change than this finding scoped; what
    // landed here caps what's SENT, which is the part that was actually
    // unbounded (a client rendering "the whole transcript" in one response).
    // The read-everything-to-parse-it cost remains a known follow-up.
```

## Original rationale: bags/sessions/api/src/ttl-cleanup.ts

```text
// astra review SR5: this used to run 3 separate COUNT queries first —
    // one to decide whether there was anything to delete, two more purely
    // to log a message/tool_call breakdown — each a full scan of the same
    // predicate the DELETE was about to execute anyway, on a table that
    // only grows. `deleteMessagesOlderThan` now deletes in bounded batches
    // and reports its own count; nothing needs to be counted first.
    //
    // The "was there anything to delete" gate the first COUNT provided is
    // preserved for free: a cutoff with zero matching rows makes the first
    // (and only) batch's DELETE affect 0 rows, which is below the batch
    // size, so the loop exits after that one cheap no-op — no separate
    // check needed.
```

## Original rationale: bags/sessions/src/capture/channels.ts

```text
/**
 * How Barry learned what an agent said and did.
 *
 * Ruling §3: every persisted message carries the channel it arrived on, and a
 * guest session with N tool calls and zero capture-channel rows is an ALERT,
 * not silence. That sentence is the whole reason this vocabulary exists — you
 * cannot alert on missing capture without being able to say what capture was
 * supposed to happen.
 */
```

## Original rationale: bags/sessions/src/capture/coverage.ts

```text
/**
 * Whether capture is actually happening.
 *
 * Ruling §3: a guest session with N tool calls and zero capture-channel rows is
 * an ALERT, not silence. The hard part is that a broken reader and a quiet
 * agent produce the same thing — no rows — so the only way to tell them apart
 * is to count what was ATTEMPTED alongside what was stored.
 *
 * Three counters, each answering a different failure:
 *  - `located` distinguishes "no transcript exists" from "we looked in the
 *    wrong place". A `locate()` pointed at a directory a vendor moved returns
 *    null forever and looks exactly like a session that never wrote anything.
 *  - `linesRead` vs `entriesParsed` catches a reader that has stopped
 *    understanding its format after a vendor bump: the file is full, the
 *    parser yields nothing, and the session looks idle.
 *  - `dedupeHits` distinguishes "nothing new" from "nothing read".
 */
```

## Original rationale: bags/sessions/src/capture/otel-events.ts

```text
/**
 * Claude's OpenTelemetry, as Barry events.
 *
 * This is claude guest-plus's capture side: the unmodified
 * interactive binary PUSHES prompts, assistant text, tool input and output,
 * tokens and decisions to a receiver Barry runs — no hooks, no file parsing,
 * and no cooperation from the TUI beyond the environment it was launched with.
 *
 * Verified in research E8 with `CLAUDE_CODE_ENABLE_TELEMETRY=1`,
 * `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` and the
 * three `OTEL_LOG_*` flags; tool OUTPUT needs
 * `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` as well.
 *
 * **Declared gaps, because a capture level is a claim** (hence `near-total`,
 * not `total`, in claude's guest-plus mode): thinking is redacted, bodies
 * truncate at 60 KB, the tracing flag is beta, and issue #92056 notes bash text
 * is exported regardless of the flags.
 */
```

## Original rationale: bags/sessions/src/delivery/format-inbox.ts

```text
/**
 * How a delivered message reads to the agent receiving it.
 *
 * Ruling §6.1 invariant 2: every surface delivers the SAME text. A message
 * that reads one way when it arrives on a tool result and another way when it
 * wakes the session is two features to maintain and two ways to confuse the
 * reader about who is talking to them.
 *
 * The copy differs by where the message came FROM, not by how it arrived: a
 * phone prompt and another session's message are different conversations, and
 * an agent told its phone buzzed will go looking for a phone that does not
 * exist. This lived in `bags/mcp/src/bag-proxy.ts` as `queuedPromptNote`,
 * where only the MCP tool-result path could reach it.
 */
```

## Original rationale: bags/sessions/src/delivery/guarantees.ts

```text
/**
 * The vocabulary Barry uses to answer one question: "will this message reach
 * that session, and how?"
 *
 * Ruling §6.1 invariant 4: `send_prompt` reports the recipient's live surface
 * and its guarantee, computed from a registered listener — never assumed from
 * the adapter's name. These are the values that report can take.
 */
```

## Original rationale: bags/sessions/src/delivery/matrix.ts

```text
/**
 * What every (sender × recipient) cell should do.
 *
 * Ruling §6.1's requirement is that ANY session can message any other with one
 * call, and the message arrives without a human dialog on either side — or the
 * sender is told at send time exactly why not. The N×N matrix is how that is
 * checked, and this module is its SPINE: the table of what each cell is
 * supposed to do, derived from the adapters' own declared modes.
 *
 * Deriving it matters. A hand-written expectation table is a second declaration
 * of the same facts, and when an adapter's guarantees change the table keeps
 * asserting the old ones — a matrix that passes while describing a system that
 * no longer exists. Here, changing a mode's `delivery` changes what the matrix
 * demands, automatically.
 *
 * The live half — actually starting two sessions, sending, and watching the
 * recipient's screen — needs the sandbox and real vendor binaries. This is what
 * that half compares against.
 */
```

## Original rationale: bags/sessions/src/delivery/report.ts

```text
/**
 * What to tell a sender will happen to their message.
 *
 * Ruling §6.1 invariant 4: computed from the recipient's REGISTERED listener
 * and declared mode, never assumed. The registry knows which surfaces are
 * live; this adds the two things it cannot know — whether the session is
 * running at all, and that any Barry session drains its inbox on its next MCP
 * tool call.
 *
 * The floor matters. Before this, `send_prompt` told every sender the same
 * sentence ("Will be delivered inside the target session's next tool result"),
 * which was a guess: true for a session calling Barry tools, false for one
 * grinding through native Bash — where a message sat unread for 15 minutes
 * (learning L10). An honest floor is what makes the report worth reading.
 */
```

## Original rationale: bags/sessions/src/store/messages-ttl.test.ts

```text
/**
 * astra review SR5: `cleanupExpiredRows` (bags/sessions/api/src/ttl-cleanup.ts)
 * ran three separate COUNT queries before a single unbounded DELETE — one to
 * decide whether to bother, two purely to log a breakdown neither gated
 * anything. The sweep now deletes in bounded batches
 * (`WHERE id IN (SELECT id ... LIMIT batchSize)`) and reports its own
 * per-batch count; the caller no longer counts anything first.
 *
 * Its absence was once a LIVE BUG rather than a coverage gap: the store
 * service's /maintenance/delete-messages-older-than route called an
 * implementation that deleted from a copy nothing read, while sessions.db grew
 * unbounded. With the SQLite path wired it deleted 69,253 rows in 7 batches
 * from the same fixture.
 *
 * These exercise the batching/budget loop directly, using the test-only
 * `options` override so a boundary is reachable without inserting
 * TTL_DELETE_MAX_BATCHES worth of 10k-row batches.
 *
 * Every call passes `sessionIds`. The delete is global by timestamp, and
 * suites sharing a store seed deliberately ancient rows, so an unscoped
 * `deletedRows` counted other suites' rows — "deleted exactly my 1 expired
 * row" failed as `expected 4 to be 1` roughly 1 run in 5. The counts below are
 * exact on purpose; scoping is what makes them true rather than loosening
 * them.
 */
```

## Original rationale: bags/sessions/src/store/search-messages.test.ts

```text
/**
 * The CANDIDATE CAP on the unindexed search stage.
 *
 * PORTED FROM THE PREVIOUS STORE, where the same bound existed for the same
 * reason. astra review SR3: `searchMessages` ranked EVERY case-insensitive
 * matched row by
 * `word_similarity` before limiting — a per-row cost paid across however many
 * matches existed, to return the top 20. The fix ranked only a bounded,
 * recency-ordered candidate pool (`min(500, limit*10)`).
 *
 * `searchMessagesSqlite` keeps that bound verbatim: SEARCH_MAX_CANDIDATES 500,
 * SEARCH_CANDIDATE_MULTIPLIER 10, `ORDER BY m.created_at DESC LIMIT cap`, then
 * scoring in JS. It needs the cap MORE than the previous store did, not less —
 * SQLite has no trigram index available here, so nothing indexes this stage at
 * all and the cap is the only thing bounding the scan.
 *
 * The risk the bound introduces is identical in both stores: if the true best
 * match by score sits outside the recency window, the cap silently evicts it —
 * a worse result set with no test noticing unless it looks for exactly this.
 * These tests seed that adversarial shape and confirm the genuinely best match
 * still comes back.
 *
 * WHICH STAGE THIS TESTS, and why it has to be said: `searchMessagesSqlite`
 * tries FTS5 exact, then FTS5 prefix, and only then the capped LIKE scan. The
 * cap lives on that last stage alone, so every query here is deliberately an
 * INFIX fragment ("lephant" inside "elephant"), which FTS5 cannot match at all.
 * A whole-word query would be answered by the index and would exercise none of
 * the code this file is about — the guard below asserts the fragment really is
 * invisible to both FTS5 stages rather than assuming it.
 *
 * SCORING DIFFERS FROM THE ORIGINAL BY DESIGN. The previous store ranked with
 * a word-similarity function; SQLite has no equivalent and scores by how much
 * of the row
 * the query accounts for (occurrences x needle length / text length). Both
 * satisfy "higher is more relevant", and both rank a short exact-ish text above
 * the same fragment buried in a long one — which is what makes the same
 * adversarial fixture meaningful here.
 */
```

## Original rationale: bags/sessions/src/store/search.test.ts

```text
/**
 * Session search, against SQLite.
 *
 * PORTED FROM THE PREVIOUS STORE, AND NARROWER THAN THE ORIGINAL. That
 * narrowing is the most important thing in this file, so it is stated before
 * the tests rather
 * than left to be inferred from which ones are missing.
 *
 * The previous version (astra review SR3, migration 029) folded seven fields
 * into one precomputed, trigram-indexed `search_text` column -- id, four
 * metadata keys (name, working_directory, git_branch, directive), the tags
 * array cast to text, and summary -- and gave queries under 3 characters a
 * separate prefix-matching path against id and name, because a 1-2 char
 * substring pattern cannot use a trigram index and matches nearly everything
 * anyway.
 *
 * `searchSessionsSqlite` now matches the same SEVEN fields with plain LIKE,
 * one OR branch each instead of one precomputed column: id,
 * metadata.working_directory, metadata.git_branch, metadata.directive,
 * metadata.tags, metadata.name and summary -- plus `system_prompt`, the one
 * field SQLite searches that the old `search_text` column did not, which gets
 * a case of its own below.
 *
 * Five of those were missing from the port, and their absence was silent:
 * searching by directory, branch, directive, tag or id returned an empty list
 * indistinguishable from "no matches". The tests for them were written
 * inverted, asserting the gap, with a comment saying that fixing it turns them
 * red and to replace them with real assertions. That is what happened, and the
 * per-field cases below are the replacements -- each one seeds the marker in
 * exactly ONE field and in no other, so it cannot pass by matching `name`.
 *
 * The <3-character prefix path is NOW PORTED TOO, and the gap guard that used
 * to pin its absence has been replaced by the real assertions at the bottom of
 * this file. A query under 3 characters prefix-matches `id` and
 * `metadata.name` ONLY -- not a substring, and not the other six fields. Only
 * half of the original reasoning came with it: the trigram-index half does not
 * apply to a store with no trigram index, and the surviving half is that a 1-2
 * character substring match is a firehose (measured: `search("a")` returned 20
 * rows, the limit cap, and `search("ab")` returned 10).
 */
```

## Original rationale: bags/sessions/src/store/session-helpers.ts

```text
/**
 * Rows deleted per batch by `deleteMessagesOlderThan` (astra review SR5).
 * The old shape was a single unbounded `DELETE ... WHERE created_at <
 * cutoff` — on a table that's been accumulating for a year (the default
 * retention window) or after the scheduler has been down a while, that's
 * one DELETE holding a lock and a transaction open for however many rows
 * have piled up, all at once. Chunking bounds both.
 */
```

## Original rationale: bags/sessions/src/store/session-helpers.ts

```text
/**
 * Upper bound on how many batches one call deletes before returning, even
 * if more rows are still expired (astra review SR5). Paired with a
 * wall-clock budget — either one hitting first stops the loop. A single
 * scheduled run must make real progress without running indefinitely or
 * monopolizing the connection for hours on a backlog bigger than either
 * budget allows; the next scheduled run picks up where this one left off,
 * and the caller's return value plus a progress log make that fact visible
 * rather than a silent partial cleanup.
 */
```

## Original rationale: bags/sessions/src/store/sessions-sqlite-writes.ts

```text
/**
 * Delete messages older than a cutoff, in bounded batches.
 *
 * The TTL sweep behind `Messages.deleteOlderThan`.
 *
 * Batched (astra review SR5): one
 * unbounded DELETE over a year of messages holds a write lock for as long as
 * it takes, and on SQLite that blocks every other writer on the file.
 * `budgetExhausted` distinguishes "caught up" from "stopped early, more
 * remains" so a caller cannot read a partial sweep as a complete one.
 *
 * `sessionIds` exists for tests: the delete
 * is global by timestamp, so a suite asserting on `deletedRows` would
 * otherwise count whatever backdated rows other suites had in flight.
 *
 * Deleting messages fires the counter trigger from migration 002, so
 * `sessions.message_count` follows without anything here maintaining it.
 */
```
