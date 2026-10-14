# ADR 0006: Telemetry usage and rendering invariants

## Context

Usage reports mix live measurements, inferred transcript evidence and unavailable stores. Long source comments documented the distinctions and regressions that protect them. The notes below preserve that checkpoint context.

## Decision

Keep short controlling invariants beside implementations and tests. Retain the complete source rationale here. This move changes no executable behavior.

## Consequences

Report changes must preserve provenance, parameter order, availability and latency units. Historical measurements below support the design; they are not current benchmark results.

## Note 165

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Test query text and parameters so silent clamp, exclusion and placeholder regressions fail locally.

Original rationale:

```text
/**
 * SQL is a string until it runs, so these assert the properties that silently
 * rot: parameterization, the clamps that keep a chart honest, and the exclusions
 * that keep a ranking meaningful. None of it needs a database, and all of it
 * would otherwise only be caught by a human noticing a wrong-looking chart.
 *
 * The dialect assertions exist because several of these constructs have no
 * direct SQLite equivalent and the obvious spelling is wrong: `julianday` for
 * timestamp arithmetic, rank-and-pick for percentiles, an explicit ESCAPE on
 * LIKE, and the registered functions that keep grouping in SQL without regex
 * support.
 */
```

## Note 166

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Exclude human-response tools from latency rankings because their delays measure people, not the system.

Original rationale:

```text
/**
   * The gap panel measures wall-clock between messages. For AskUserQuestion that
   * is a human deciding (measured p50 105s, p95 495s), so leaving it in makes it
   * the "slowest tool" and the panel stops meaning anything.
   *
   * The params order is load-bearing: anonymous placeholders bind by textual
   * position, and a mismatch does not error — it binds "20" against a tool
   * name and quietly renders an empty panel (found live, 2026-09-22).
   */
```

## Note 167

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Preaggregate message counts before joining sessions to avoid row explosion and repeated path normalization.

Original rationale:

```text
/**
   * The join-then-count form of this query measured 2,693ms against 51ms,
   * because it expands to a row per message before grouping and re-runs the path
   * normalization on each. Pre-aggregating is the difference between a usable
   * panel and one that blocks the event loop for seconds — SQLite queries are
   * synchronous, so there is no statement timeout to hide behind.
   */
```

## Note 168

Source: [bags/telemetry/src/usage/queries.ts](../../bags/telemetry/src/usage/queries.ts)

Usage queries return SQL and parameters separately so callers retain parameterization.

Original rationale:

```text
/**
 * Every usage query, as a pure function returning `{ text, params }`.
 *
 * Pure so the SQL can be unit-tested without a database: the tests assert that
 * windows are parameterized, that the model clamp is present, and that the gap
 * query excludes the tool whose "latency" is really human think time. None of
 * that needs a connection, and all of it is the kind of thing that silently
 * rots in a template string.
 *
 * Grouping and normalization happen in SQL rather than in the read model, so the
 * dashboard and the MCP tools cannot compute different answers from the same
 * rows — the same rule `summary.ts` already follows. The two registered
 * functions this SQL calls (`repo_of`, `bag_of`) are exceptions that prove it:
 * they exist because SQLite has no regexp_replace or split_part, and they are
 * registered by `stores.ts` on every handle so both consumers share them.
 *
 * Dialect notes that are easy to get silently wrong in SQLite:
 * timestamps are ISO-8601 TEXT, so `>=` against an ISO bound is correct
 * without casting, but timestamp ARITHMETIC must go through `julianday()`;
 * `percentile_cont` does not exist, so the gap panel rank-and-picks; `LIKE`
 * needs an explicit `ESCAPE` clause, which is not implied.
 *
 * `bagRoi` and `unattributedCalls` are deliberately absent: they need a true
 * join across the sessions and config stores, which a read-only file handle
 * per store cannot express without ATTACH — the bypass the seam decision
 * (DEFERRED-USAGE-QUERIES.md) approved only for single-file reads. Their
 * panels report unavailable until that design lands.
 */
```

## Note 169

Source: [bags/telemetry/src/usage/queries.ts](../../bags/telemetry/src/usage/queries.ts)

Clamp model reports to the date model IDs became available; earlier unknown rows would bias rankings.

Original rationale:

```text
/**
 * Earliest date `messages.model_id` was populated.
 *
 * Model attribution started here; before it, every row has a NULL model_id. A
 * chart that ran the full window would show a long empty stretch that reads as
 * "no model used" rather than "not recorded". The clamp lives in the SQL — a
 * comment saying "remember the data starts in August" would rot, a `max()`
 * cannot.
 */
```

## Note 170

Source: [bags/telemetry/src/usage/queries.ts](../../bags/telemetry/src/usage/queries.ts)

Exclude named human-response tools before computing turn-gap rankings.

Original rationale:

```text
/**
 * Excluded from the turn-gap panel by name.
 *
 * The gap between messages includes whatever happened in between, and for
 * AskUserQuestion that is a human deciding — measured p50 105s, p95 495s. Left
 * in, it dominates the "slowest" ranking and makes the whole panel read as
 * nonsense. Agent is excluded for the same reason at a smaller scale: the gap
 * spans an entire subagent run, not a tool call.
 */
```

## Note 171

Source: [bags/telemetry/src/usage/queries.ts](../../bags/telemetry/src/usage/queries.ts)

Read session-per-identity counts from their owning store without joining every message.

Original rationale:

```text
/**
 * Sessions per identity, from the sessions store alone.
 *
 * The identities table lives in a different file, so the id→name mapping is
 * merged in the read model (`sessionCountsByIdentity` here and `identityNames`
 * below are the two halves; summary-usage joins them). The grouping — the part
 * that must be identical for every consumer — stays in SQL; only the two-row
 * lookup crosses files. Unattributed sessions are labelled at that merge, never
 * dropped: a fifth of them have no identity, and silently excluding them would
 * make the totals disagree with every other panel for no visible reason.
 */
```

## Note 172

Source: [bags/telemetry/src/usage/queries.ts](../../bags/telemetry/src/usage/queries.ts)

Rank recorded model IDs within their supported observation window.

Original rationale:

```text
/**
 * Which models actually ran.
 *
 * `max(?, ?)` is the clamp (SQLite's two-argument scalar max): the window can
 * never start before model attribution existed, so the panel cannot draw an
 * empty stretch that looks like "no model" instead of "not recorded". ISO text
 * compares lexicographically, which is correct here.
 */
```

## Note 173

Source: [bags/telemetry/src/usage/queries.ts](../../bags/telemetry/src/usage/queries.ts)

Attribute MCP calls to the serving bag rather than treating each tool name as an unrelated owner.

Original rationale:

```text
/**
 * MCP tool calls attributed to the bag that serves them.
 *
 * `bag_of` (registered; see stores.ts) reads the second `__` segment. Only bags
 * that were actually called appear here; the zero-call ones are computed by
 * differencing against the registry, which is exactly the part that needs the
 * cross-file join this port stopped before — see the module comment.
 */
```

## Note 174

Source: [bags/telemetry/src/usage/queries.ts](../../bags/telemetry/src/usage/queries.ts)

Message gaps approximate elapsed time, not direct tool execution duration.

Original rationale:

```text
/**
 * Time between consecutive messages in a session, per tool.
 *
 * A PROXY, and labelled as one everywhere it surfaces. It measures wall-clock
 * between rows, which includes model thinking and anything else that happened —
 * not tool execution time. Real durations need per-call timing that is currently
 * computed and discarded.
 *
 * The 900s clip is load-bearing: one session paused overnight otherwise lands a
 * 40,000-second gap in the p95 and the ranking becomes meaningless.
 *
 * `percentile_cont` has no SQLite spelling. Rank-and-pick within each tool
 * group is the substitute: rn = ceil(fraction * n) over the ordered gaps. It
 * interpolates less than percentile_cont would, but on a wall-clock proxy with
 * a 900s clip the difference is below the panel's resolution, and the label
 * already says "proxy".
 */
```

## Note 175

Source: [bags/telemetry/src/usage/queries.ts](../../bags/telemetry/src/usage/queries.ts)

Aggregate action outcomes using their stored statuses and completed durations.

Original rationale:

```text
/**
 * Action runs grouped by action and outcome.
 *
 * `action_runs` carries real `started_at`/`completed_at`, so unlike everything
 * else in this bag these durations are measured rather than inferred. The
 * epoch arithmetic is julianday — SQLite subtracts ISO text as strings.
 *
 * The runs are split across partitions, so this returns the summed duration
 * and the number of runs that have one, and the read model divides after
 * merging. Most runs never record `completed_at`; dividing by every run would
 * understate the average several times over.
 */
```

## Note 176

Source: [bags/telemetry/src/usage/queries.ts](../../bags/telemetry/src/usage/queries.ts)

Report unfinished runs explicitly rather than treating an absent finish time as success.

Original rationale:

```text
/**
 * Runs that started and never finished.
 *
 * Deliberately NOT windowed. A run stuck open for two weeks falls outside a
 * 7-day window and disappears from the report exactly as it becomes most worth
 * reporting — the longer it is stuck, the more invisible a windowed query makes
 * it. The open-duration clock is `julianday('now')`.
 */
```

## Note 177

Source: [bags/telemetry/src/usage/report-cache.ts](../../bags/telemetry/src/usage/report-cache.ts)

Coalesce concurrent usage reads and cache bounded results to protect the database event loop.

Original rationale:

```text
/**
 * In-process cache + single-flight coalescing for the database-backed usage
 * reports (usage/tools/reliability).
 *
 * Each report rebuild fires several concurrent queries (see
 * `usageOverview`, `toolIntelligence`, `healthReport` in summary-usage.ts) —
 * real work against a pool of 2 connections shared with everything else this
 * bag does. Every dashboard page polls on a schedule (15-60s), and several
 * browser tabs can be open on the same page at once, so without a cache two
 * requests arriving together each trigger their own full rebuild: the exact
 * shape that doubles database load for no new information, since nothing
 * changed between them.
 *
 * Two mechanisms, layered:
 *
 * 1. A ~30s TTL cache, keyed by whatever varies the report (here: the
 *    requested window in days). A request within the TTL of the last
 *    successful build gets that build back immediately, with no query at all.
 * 2. In-flight coalescing: a request that arrives while a rebuild for the
 *    same key is already running AWAITS THAT REBUILD rather than starting a
 *    second one. This is what actually matters under concurrency — the TTL
 *    alone does nothing for two requests that arrive within the same
 *    millisecond, before either has a cached value to serve.
 *
 * A `Promise<T>` held per key is set before the async work starts and cleared
 * in a `finally`, so concurrent callers made while it is set all resolve from
 * the same promise instead of firing their own query.
 */
```

## Note 178

Source: [bags/telemetry/src/usage/report-cache.ts](../../bags/telemetry/src/usage/report-cache.ts)

Key cached reports by their requested window so unrelated queries cannot reuse the wrong result.

Original rationale:

```text
/**
 * A TTL cache with single-flight coalescing, keyed by an arbitrary string
 * (e.g. the requested window in days).
 *
 * One instance per report type: the usage overview, tool intelligence and
 * health report caches are independent of each other and of any other
 * report's rebuild, exactly like the plan calls for — one panel's rebuild
 * must never be delayed by another's.
 */
```

## Note 179

Source: [bags/telemetry/src/usage/report-cache.ts](../../bags/telemetry/src/usage/report-cache.ts)

Share one in-flight build per key and expire completed results without caching a failed promise.

Original rationale:

```text
/**
   * Get the cached value for `key`, rebuilding via `build()` if there is none
   * or it has expired.
   *
   * Concurrent calls with the same `key` while a rebuild is in flight all
   * share that one rebuild's promise — `build` runs exactly once, regardless
   * of how many callers arrived while it was running.
   */
```

## Note 180

Source: [bags/telemetry/src/usage/requests.test.ts](../../bags/telemetry/src/usage/requests.test.ts)

Latency bucket boundaries must agree with stored units and exclude unavailable durations.

Original rationale:

```text
/**
   * The bucketing bug this test exists for.
   *
   * `ts / ?` with a BOUND parameter is float division — the value arrives as a
   * float, nothing truncates, and every distinct second becomes its own bucket.
   * On real data that produced 2,406 "daily" buckets for a 30-day window, each
   * showing a single request: a chart that renders plausibly and is entirely
   * wrong. The same query with a literal 86400 returned 9.
   */
```

## Note 181

Source: [bags/telemetry/src/usage/requests.test.ts](../../bags/telemetry/src/usage/requests.test.ts)

Resume request-log ingestion by byte offset, including multibyte input and truncation.

Original rationale:

```text
/**
 * Byte-offset tracking for ingestLog.
 *
 * A naive offset scheme — always seek to whatever was stored last — reads
 * garbage or nothing after a log rotation or truncation, because the stored
 * offset can point past the end of a fresh, shorter file. The fix is
 * `resolveStartOffset`: any stored value that cannot possibly still point
 * into the file resets to 0, and the existing watermark filter is what keeps
 * that full re-read from duplicating rows already stored.
 */
```

## Note 182

Source: [bags/telemetry/src/usage/requests.test.ts](../../bags/telemetry/src/usage/requests.test.ts)

A corrupt negative offset resets ingestion exactly like truncation rather than seeking invalid input.

Original rationale:

```text
/**
   * Negative control: a corrupt offset (negative) must be handled exactly
   * like a detected truncation — reset and re-read — rather than crashing the
   * ingester or seeking to a nonsense position. This is the "negative
   * control: corrupt offset" coverage the review calls for explicitly,
   * distinct from the ordinary truncation happy path above.
   */
```

## Note 183

Source: [bags/telemetry/src/usage/requests.ts](../../bags/telemetry/src/usage/requests.ts)

Store structured request telemetry separately from general warning/error logs.

Original rationale:

```text
/**
 * Request telemetry, parsed from the services' pino logs into local SQLite.
 *
 * ## Why a snapshot rather than reading the logs live
 *
 * The log files are not a store. The supervisor rotates a service's log once
 * it passes 10MB and keeps only a few rotations, so a busy service loses its
 * older lines within days. A dashboard that reads the files directly would
 * silently start showing less and less.
 *
 * So this ingests incrementally: each pass reads only lines newer than the
 * newest already stored, and the SQLite copy survives truncation.
 *
 * ## Why not Axiom
 *
 * Axiom holds the same stream and is the right long-term source, but it is a
 * network dependency with its own auth and query language, and the dashboard
 * must keep working when the network does not. Local first; Axiom can become a
 * second source later without changing the read model.
 */
```

## Note 184

Source: [bags/telemetry/src/usage/requests.ts](../../bags/telemetry/src/usage/requests.ts)

Collapse identifier path segments so route aggregation does not expose per-object URLs.

Original rationale:

```text
/**
 * Collapse identifier segments to `:id`.
 *
 * Mirrors `templatePath` in @barry-rocks/sdk/services, applied again at INGEST because
 * history written before that fix shipped still carries raw ids. Without it the
 * same handler appears as hundreds of routes and no aggregation means anything.
 *
 * Deliberately narrow, for the same reason as the original: over-templating
 * silently merges unrelated endpoints, which is a quieter failure than missing
 * one.
 */
```

## Note 185

Source: [bags/telemetry/src/usage/requests.ts](../../bags/telemetry/src/usage/requests.ts)

Resume by byte offset while excluding records at or before the watermark.

Original rationale:

```text
/**
 * Ingest a log file, resuming from its stored byte offset and skipping
 * anything at or before the watermark.
 *
 * The byte offset is the fast path: a normal pass reads only what was
 * appended since the last one, rather than re-scanning a file that can sit at
 * several MB. It is deliberately not the ONLY guard — `resolveStartOffset`
 * resets it to 0 on rotation, truncation or corruption, and when that happens
 * this necessarily re-reads lines already stored. The watermark filter (and
 * `INSERT OR IGNORE` on a deterministic id) is what makes that harmless: a
 * full re-read after a reset cannot duplicate rows already captured, exactly
 * as it always could before offsets existed.
 */
```

## Note 186

Source: [bags/telemetry/src/usage/requests.ts](../../bags/telemetry/src/usage/requests.ts)

Aggregate route latency and errors from measured requests, retaining the selected time window.

Original rationale:

```text
/**
 * Latency and error rate per route.
 *
 * Percentiles are picked by row offset — SQLite has no percentile_cont. Exact
 * for the sample rather than interpolated, which is what you want when the
 * question is "how slow does this actually get".
 */
```

## Note 187

Source: [bags/telemetry/src/usage/stores.ts](../../bags/telemetry/src/usage/stores.ts)

Open owning stores read-only so dashboards cannot become an alternate writer.

Original rationale:

```text
/**
 * Read-only handles on the SQLite stores the usage panels read.
 *
 * The tables the panels read live in several stores, and this module is where
 * the panels learn their addresses. Handles are
 * opened `readonly`: the stores are WAL-mode, so these readers never block the
 * writers, and a read model that can write is a read model that will.
 *
 * The seam was chosen deliberately (2026-09-22): opening the store files
 * directly bypasses session-client, whose header reserves the sessions tables
 * to itself. The alternative — aggregate reads added to session-client — is
 * the better end state and is recorded in DEFERRED-USAGE-QUERIES.md as
 * the follow-up; these panels were permanently `unavailable` until then, and
 * a read-only file handle is the smallest honest bridge. The bagRoi and
 * unattributedCalls queries, which need a true cross-file join, stay
 * unavailable rather than shipping this bypass for them.
 *
 * Path resolution mirrors each store's owner, rule for rule, because a bag
 * that guesses a path is one rename from reading nothing: each store lives in
 * its bag's data directory. Each rule cites its owner
 * so a change there shows up here as a wrong answer, not a silent success.
 */
```

## Note 188

Source: [bags/telemetry/src/usage/stores.ts](../../bags/telemetry/src/usage/stores.ts)

Normalize worktree paths to their parent repository before grouping usage.

Original rationale:

```text
/**
 * `repo_of(working_directory)` — fold a worktree path into its parent repo.
 *
 * `~/repos/barry/.claude/worktrees/x` counts as barry. Left raw, a busy repo
 * scatters across a dozen rows and the panel answers nothing. SQLite has no
 * regex support, so the normalization is a
 * registered function: the grouping stays in SQL — the reason it moved there
 * in the first place is so the dashboard and the MCP tools cannot compute
 * different answers — while the string munging lives in exactly one place.
 */
```

## Note 189

Source: [bags/telemetry/src/usage/stores.ts](../../bags/telemetry/src/usage/stores.ts)

Resolve the serving bag from the MCP tool name before attributing usage.

Original rationale:

```text
/**
 * `bag_of(tool_name)` — the bag serving an MCP tool.
 *
 * Tool names are `mcp__<server>__<tool>`, so the second segment is the bag.
 * A registered function for the same reason as
 * repoOf: no split_part in SQLite, and the attribution rule must not fork
 * between the web page and the tools.
 */
```

## Note 190

Source: [bags/telemetry/src/usage/stores.ts](../../bags/telemetry/src/usage/stores.ts)

Check the covering index explicitly so slow fallback queries remain visible.

Original rationale:

```text
/**
 * Whether the tool-call covering index exists on the messages table.
 *
 * SQLite builds indexes inline, so there is no half-built state to
 * distinguish: presence is the whole question. Without the index the tool
 * leaderboard sequential-scans every message.
 */
```

## Note 191

Source: [bags/telemetry/src/usage/summary-usage.test.ts](../../bags/telemetry/src/usage/summary-usage.test.ts)

A missing store returns unavailable; it must not look like a successful empty report.

Original rationale:

```text
/**
 * The failure-visibility contract, made executable.
 *
 * The rule this enforces: a panel whose source is DOWN must not look like a
 * panel whose source is fine and simply had nothing to report. These tests exist
 * because that distinction is invisible in a screenshot and easy to lose in a
 * refactor — and losing it produces a dashboard that reports zero activity for a
 * store it cannot reach.
 */
```

## Note 192

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Share usage read models between dashboard and MCP tools to preserve result semantics.

Original rationale:

```text
/**
 * Read models for the usage dashboard, shared by the web app and the MCP tools.
 *
 * Mirrors `summary.ts`: a question must be answered identically whether it is
 * asked from a browser or from a session, because a dashboard and a tool that
 * disagree are worse than either alone.
 *
 * Everything here returns a `Panel`, never a bare array. That is deliberate —
 * see below.
 *
 * The data source is the SQLite stores (`stores.ts`), read-only. Queries are
 * synchronous through better-sqlite3, which
 * means a slow panel blocks this process's event loop rather than timing out
 * server-side — the indexes the queries rely on are what keeps that honest.
 */
```

## Note 193

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Reported query duration is clamped for rendering; this does not cancel SQLite execution.

Original rationale:

```text
/**
 * Ceiling for a panel query's reported duration. Nothing kills a SQLite query
 * at 5s the way a server-side statement timeout would, so this is a rendering
 * clamp on a measured value, not a statement of what the database allowed. The
 * panel's ms field is advisory either way; the sync-blocking hazard is the
 * index's job to prevent.
 */
```

## Note 194

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Classify query failures explicitly so an unavailable panel differs from a measured empty result.

Original rationale:

```text
/**
 * Run one query and classify the outcome.
 *
 * A thrown error becomes `unavailable` carrying the message: a syntax error
 * reads differently from a missing store, and the difference is the whole
 * diagnosis. Zero rows becomes `empty` with an explanation naming the window, so
 * the reader knows the query ran and found nothing rather than wondering.
 */
```

## Note 195

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Expose short actionable failure reasons without replacing a failed panel with zero values.

Original rationale:

```text
/**
 * A short, actionable failure reason.
 *
 * better-sqlite3 reports constraint and SQL errors through its own exception
 * codes (SQLITE_*); the text alone is often a stack fragment, so the first
 * line is what a panel gets.
 */
```

## Note 196

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Keep measured tool durations distinct from message-gap approximations.

Original rationale:

```text
/**
 * Cost, tokens and measured tool durations.
 *
 * Reads the bag-owned usage.db rather than the session stores — this is the
 * one data set Barry writes for itself.
 *
 * The window is CLAMPED to the first recorded row. Tokens before telemetry
 * existed were never captured and cannot be reconstructed, so a longer window
 * would render zeros for a period that was never measured — a fabricated zero in
 * the same ink as a real one. Panels say "measuring since {date}" instead.
 */
```

## Note 197

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Read tool and bag usage through the same ownership and time-window contracts.

Original rationale:

```text
/**
 * Tool and bag usage for the Tool Intelligence page.
 *
 * Separate from `usageOverview` so the two pages fail independently: the
 * bag-ROI panels were the most expensive thing here, and the split kept them
 * from delaying or breaking the activity panels. The bag panels are currently
 * `unavailable` by design, not by accident: bagRoi's zero-call rows need the
 * bag registry joined to the calls, across two files, and the seam decision
 * stopped before that join.
 */
```

## Note 198

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Expose quiet failures as unavailable evidence rather than implying reliable operation.

Original rationale:

```text
/**
 * Reliability: what is quietly broken.
 *
 * Failed and stuck action runs, the event stream's own error rate, session
 * outcomes. The database-health panels that shared this report are gone with
 * the server they measured — SQLite has no buffer cache, connection pool or
 * per-statement timing view to report on, and a panel that can only ever say
 * "unavailable" trains the reader to ignore the page.
 * DEFERRED-USAGE-QUERIES.md records the decision.
 *
 * `stuckRuns` is intentionally not windowed: a run open for two weeks would
 * fall out of a 7-day window exactly as it became most worth reporting.
 */
```

## Note 199

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Join identity and session aggregates without expanding them to one row per message.

Original rationale:

```text
/**
 * Sessions per identity, assembled across the two stores that hold it.
 *
 * This is the one panel whose answer is not a single SQL string: the counts
 * live in sessions.db and the names in identities.db, and the files cannot be
 * joined without ATTACH. The grouping stays in SQL (`sessionCountsByIdentity`);
 * only the two-row id→name lookup merges here — the same rows for every
 * consumer, because every consumer calls this function.
 */
```

## Note 200

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Assemble one usage-page response while preserving independent panel availability.

Original rationale:

```text
/**
 * Everything the Usage & Activity page needs, in one round trip.
 *
 * Queries run against read-only handles on the stores, so the page costs about
 * as long as its slowest panel rather than their sum. One panel failing must
 * not take the others with it — each is classified independently.
 */
```

## Note 201

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Warn when the covering index is absent so degraded query behavior does not remain invisible.

Original rationale:

```text
/**
 * Warn when the covering index is absent.
 *
 * Without it the tool leaderboard is a sequential scan over every message —
 * measured at 1,923ms against 15ms with it. A fresh machine would
 * otherwise just be mysteriously slow, with nothing naming the cause.
 */
```

## Note 202

Source: [bags/telemetry/src/usage/telemetry.test.ts](../../bags/telemetry/src/usage/telemetry.test.ts)

WAL and a bounded busy timeout protect concurrent API writes from dashboard readers.

Original rationale:

```text
/**
   * The API server writes this file while the dashboard reads it. Without WAL a
   * reader blocks a writer, and without busy_timeout a concurrent write returns
   * SQLITE_BUSY immediately — which for a fire-and-forget insert means silently
   * losing the row. metrics.db can skip the timeout because it has one writer;
   * this cannot.
   */
```

## Note 203

Source: [bags/telemetry/src/usage/telemetry.ts](../../bags/telemetry/src/usage/telemetry.ts)

Store measured tokens, costs and durations separately from inferred transcript data.

Original rationale:

```text
/**
 * Token, cost and tool-duration telemetry.
 *
 * A store of its own, deliberately not a table in Barry's main database. The metrics
 * bag must add no write pressure to the database whose health it reports on, and
 * this is the highest-volume thing it records: on a busy day ~5,000 tool
 * invocations against ~9,000 message rows.
 *
 * The API server writes it and this bag reads it, which is the same shape
 * `@barry-rocks/file-tracker` already uses from `servers/api` — WAL plus a
 * busy_timeout, one writer process and one reader.
 *
 * ## Why this data needs a home at all
 *
 * Every provider adapter builds a TokenUsage {inputTokens, outputTokens,
 * costUsd, durationMs} and sdk-manager assembles it into a log line. That was
 * the end of it: the numbers existed in memory for microseconds and were then
 * discarded, so "what does Barry cost me" had no answer at any price.
 *
 * The same is true of per-tool duration — computed at tool_result, logged, and
 * the timer deleted on the next line.
 */
```

## Note 204

Source: [bags/telemetry/src/usage/telemetry.ts](../../bags/telemetry/src/usage/telemetry.ts)

Store opening and migration are idempotent for both writers and readers.

Original rationale:

```text
/**
 * Open and migrate. Idempotent, so every writer and reader can call it.
 *
 * `busy_timeout` is not optional here, unlike in metrics.db which has a single
 * writer. Two processes write and read this file, and without a timeout a
 * concurrent write returns SQLITE_BUSY immediately — which for fire-and-forget
 * telemetry means silently losing the row.
 */
```

## Note 205

Source: [bags/telemetry/src/usage/telemetry.ts](../../bags/telemetry/src/usage/telemetry.ts)

Record usage per turn so retries and later transcript recovery can be distinguished.

Original rationale:

```text
/**
 * One turn's model usage.
 *
 * `session_id` is a plain column, NOT a foreign key into anything. This store
 * stands alone, so telemetry outlives the session it describes — the same intent
 * behind `events.session_id` being ON DELETE SET NULL rather than cascading.
 * Deleting a session should not erase what it cost.
 */
```

## Note 206

Source: [bags/telemetry/src/usage/telemetry.ts](../../bags/telemetry/src/usage/telemetry.ts)

Recompute costs from stored tokens without altering the underlying usage observations.

Original rationale:

```text
/**
 * Recompute `cost_usd` from the tokens already stored on each row.
 *
 * The transcript ingest can only cost a row while the vendor's transcript file
 * still exists, and the vendor prunes them — 279 of 510 recorded paths were
 * already gone at the time of writing. Rows ingested before a model had a price
 * therefore keep their NULL forever: adding the rate fixes new rows and rows
 * whose file survives, and silently misses the rest. That left $853 of real
 * spend permanently invisible after Fable 5 and Opus 4.8 were priced.
 *
 * Token counts are already on the row, so cost is recoverable without the
 * transcript. This reprices from `PRICING` via the same `priceFor` the ingest
 * uses — deliberately not a second copy of the arithmetic, which would be free
 * to drift from `costOf()` and produce two different answers for one row.
 *
 * Only touches rows where `cost_usd IS NULL`; a row that already has a cost is
 * left alone, so this is safe to re-run and cannot rewrite history. Returns the
 * number of rows repriced.
 */
```

## Note 207

Source: [bags/telemetry/src/usage/telemetry.ts](../../bags/telemetry/src/usage/telemetry.ts)

Insert each invocation batch atomically so partial telemetry cannot distort aggregates.

Original rationale:

```text
/**
 * Insert a batch of tool invocations in one transaction.
 *
 * Batched because a busy day produces ~5,000 of these. One transaction per call
 * would be one fsync per tool call on the session's hot path — the cost of
 * measuring would start to matter, which is the failure a telemetry store is
 * supposed to avoid being.
 */
```

## Note 208

Source: [bags/telemetry/src/usage/telemetry.ts](../../bags/telemetry/src/usage/telemetry.ts)

Absent measurement-start time means unavailable coverage rather than no usage.

Original rationale:

```text
/**
 * When measurement began, as a unix timestamp — or undefined if it never has.
 *
 * Cost panels clamp their window to this and say "measuring since {date}".
 * Tokens before this point were never recorded and cannot be reconstructed;
 * drawing a flat zero line back through that period would be a fabrication
 * rendered in the same ink as a measurement.
 */
```

## Note 209

Source: [bags/telemetry/src/usage/telemetry.ts](../../bags/telemetry/src/usage/telemetry.ts)

Return spend in chronological order over the selected window.

Original rationale:

```text
/**
 * Spend per day, oldest first.
 *
 * `since` is clamped by the caller to `measuringSince()` — a window reaching
 * before the first recorded row would render zeros for a period that was never
 * measured, and a fabricated zero sits in the same ink as a real one.
 */
```

## Note 210

Source: [bags/telemetry/src/usage/telemetry.ts](../../bags/telemetry/src/usage/telemetry.ts)

Use recorded tool durations for latency; message gaps are only an approximation.

Original rationale:

```text
/**
 * Measured tool durations — the real thing the turn-gap panel approximates.
 *
 * This supersedes that proxy. `gap` measures wall-clock between messages and
 * includes model thinking.
 *
 * Two writers now feed this table and they measure slightly different spans.
 * sdk-manager's timer brackets the tool handler itself (tool_start to
 * tool_result) but only ever sees API-executed sessions. The transcript
 * backfill covers `barry start` sessions — which is nearly all of them, and why
 * this table sat at 0 rows — and derives duration from the gap between the two
 * logged records, so it also contains the vendor's dispatch overhead. It is an
 * upper bound, biased high by a small constant: good enough to rank tools by
 * cost, not to check one against a millisecond budget. See `pairToolCalls`.
 */
```

## Note 211

Source: [bags/telemetry/src/usage/telemetry.ts](../../bags/telemetry/src/usage/telemetry.ts)

Unknown tool error flags remain unknown rather than becoming successful calls.

Original rationale:

```text
/**
 * Share of tool calls whose error state is known.
 *
 * Reported so the error-rate panel can say how much it actually saw.
 *
 * This was 0% for as long as the only writer was the runner's in-runner timer,
 * whose event carries no error flag. Transcript-recovered rows DO carry one —
 * the vendor writes `is_error` on the tool_result block — so coverage is now
 * 78.2% of 42,012 rows, with the remaining 22% being results the vendor
 * recorded no flag for. Those stay NULL rather than being assumed successful:
 * printing "0% errors" over an unknown denominator is the same unsupported
 * claim in the other direction.
 */
```

## Note 212

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

Recover transcript costs from vendor-recorded usage without pretending they were measured live.

Original rationale:

```text
/**
 * Cost recovered from the vendor CLI's own transcripts.
 *
 * `barry start` spawns the vendor binary with inherited stdio, so Barry never
 * sees the token counts as they happen. It does know where the vendor wrote its
 * transcript, and those files carry the full usage payload — so the numbers are
 * recoverable afterwards even though they cannot be intercepted.
 */
```

## Note 213

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

Recover tool duration only from a matched invocation/result pair.

Original rationale:

```text
/**
 * Tool durations recovered from the same transcripts.
 *
 * The transcript carries no `duration_ms` field, but it does carry a link: a
 * `tool_result` record's `parentUuid` points at the assistant record holding the
 * matching `tool_use` block, and both are timestamped. Across 400 real
 * transcripts this pairs 42,988 of 42,988 results — 100%.
 */
```

## Note 214

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

Parse quoted error flags explicitly; Boolean("False") incorrectly marks successful calls as errors.

Original rationale:

```text
/**
   * REGRESSION — `Boolean(block.is_error)` is wrong for a quoted flag, because
   * `Boolean("False")` is `true` and every successful call would be relabelled
   * an error. Today's corpus writes real booleans (`"is_error":false` 38,075,
   * `"is_error":true` 1,748, no quoted form), so the boolean case is the one
   * that actually runs; the quoted cases guard against a vendor that starts
   * emitting Python-style values. All three are pinned so a future simplification
   * to `Boolean(...)` fails here rather than in the error-rate panel.
   */
```

## Note 215

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

Clamp transcript wall-clock deltas so host sleep cannot become multi-day tool latency.

Original rationale:

```text
/**
   * REGRESSION — the `barry.health.ms` bug in this store's other half. These are
   * wall-clock deltas between two logged lines, so a host sleep or a human
   * pausing at a prompt lands in the store as a multi-minute "tool call": the
   * real corpus maximum is 375,909,151 ms, 4.35 days. Fails against an
   * implementation with no ceiling.
   */
```

## Note 216

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

Human-response tools are excluded from system latency measurements.

Original rationale:

```text
/**
 * Tools that block on a human are not latency measurements.
 *
 * The ceiling drops their extremes but leaves the survivors, which is the worse
 * failure: a 250s p95 that looks measured. In the real store these took the top
 * two p95 slots, reporting the user's own response time as Barry's slowest path.
 */
```

## Note 217

Source: [bags/telemetry/src/usage/transcripts.ts](../../bags/telemetry/src/usage/transcripts.ts)

Transcript recovery supplements recorded usage while retaining its inferred provenance.

Original rationale:

```text
/**
 * Cost and token usage recovered from the vendor CLI's own transcripts.
 *
 * ## Why this exists
 *
 * `barry start` does not run the agent inside Barry — it spawns the vendor CLI
 * (`spawn("claude", args, { stdio: "inherit" })`), so the token counts are
 * consumed in a process Barry never reads from. No hook placed in Barry can
 * intercept them; I tried two before establishing that.
 *
 * But the vendor writes its own JSONL transcript, and Barry already records
 * where: `sessions.metadata.transcript_path`, populated for 429 sessions with
 * 283 still on disk. Those files carry the FULL usage payload per assistant
 * turn, including the cache split that the provider adapters drop.
 *
 * So the counts cannot be intercepted, but they can be READ AFTERWARDS. That is
 * a different mechanism — parsing someone else's format on a schedule — with a
 * different failure mode: it is retrospective, and it is only as complete as
 * the files that still exist.
 */
```

## Note 218

Source: [bags/telemetry/src/usage/transcripts.ts](../../bags/telemetry/src/usage/transcripts.ts)

Malformed transcript lines must not abort recovery of other complete records.

Original rationale:

```text
/**
 * Parse one transcript line.
 *
 * Returns null for anything that is not an assistant turn carrying usage —
 * user messages, tool results, summaries, and malformed tails of a file still
 * being written.
 */
```

## Note 219

Source: [bags/telemetry/src/usage/transcripts.ts](../../bags/telemetry/src/usage/transcripts.ts)

Bound inferred tool duration because transcript timestamps include sleep and human pauses.

Original rationale:

```text
/**
 * Ceiling for a transcript-derived tool duration, in milliseconds.
 *
 * This is the same defence as `elapsedMs`/`SAMPLER_CEILING_MS` in `src/collect.ts`
 * and it exists for the same reason, arrived at from the opposite direction. There
 * the bug was `Date.now()` advancing while the laptop was shut; here EVERY figure
 * is wall clock by construction — the delta between two lines the vendor wrote —
 * and no monotonic clock is available after the fact, so the clamp is the only
 * defence rather than the second one.
 *
 * The artifact is real and measurable in the corpus: across 400 transcripts the
 * maximum delta is 375,909,151 ms — 4.35 DAYS — for a single "tool call". 185 of
 * 42,988 samples (0.43%) exceed this ceiling.
 *
 * 300s matches SAMPLER_CEILING_MS deliberately, so the two ceilings do not drift
 * apart for no reason. It is generous on purpose: a real `Bash` running a long
 * build legitimately takes minutes, and this exists to reject sleep and
 * human-wait artifacts, not to police slowness.
 */
```

## Note 220

Source: [bags/telemetry/src/usage/transcripts.ts](../../bags/telemetry/src/usage/transcripts.ts)

Human-response tool duration measures response time and is excluded from latency rankings.

Original rationale:

```text
/**
 * Tools whose duration is a human's response time, not the system's.
 *
 * These block on the USER answering a prompt, so the transcript delta measures
 * how long someone took to read and reply — a real number, but not one that
 * belongs in a panel headed "slowest tools". The corpus is unambiguous:
 * `AskUserQuestion` averages 94,566 ms with 162 of 226 calls over 30s and
 * `ExitPlanMode` averages 117,112 ms, against `Read` at 1,278 ms with 1 of 2,036
 * over 30s. Left in, they take the top two p95 slots and the panel reports the
 * user's lunch break as Barry's worst latency.
 *
 * The ceiling alone does not solve this — it drops the extremes and leaves the
 * survivors, which is worse than either extreme: a confidently wrong 250s p95
 * that looks measured. So these are excluded by NAME, on the different and
 * honest ground that the quantity is not tool latency at all.
 *
 * Excluding rather than clamping also keeps `errorCoverage` honest, since these
 * calls do still carry a real success/failure flag — see the note in
 * `pairToolCalls` about why a dropped row beats a fabricated one.
 */
```

## Note 221

Source: [bags/telemetry/src/usage/transcripts.ts](../../bags/telemetry/src/usage/transcripts.ts)

Pair an invocation with its matching result before inferring elapsed duration.

Original rationale:

```text
/**
 * One tool call, recovered from the pair of transcript records that bracket it.
 *
 * IMPORTANT: `durationMs` is NOT the same measurement as the live in-runner timer
 * that `servers/api/src/sdk-manager.ts` writes. That timer brackets the tool
 * handler itself, from `tool_start` to `tool_result`. This is the wall-clock gap
 * between the assistant record carrying the `tool_use` block and the user record
 * carrying its `tool_result`, so it also contains the vendor's own dispatch
 * overhead and the time the transcript lines took to be written. It is an upper
 * bound on the tool's own time, biased high by a small constant.
 *
 * The two are close enough to answer "which tools are slow" and NOT close enough
 * to compare against a latency budget to the millisecond. Anyone tempted to union
 * these rows with runner-timed ones should know they are averaging two different
 * quantities.
 */
```

## Note 222

Source: [bags/telemetry/src/usage/transcripts.ts](../../bags/telemetry/src/usage/transcripts.ts)

Preserve unknown error state and parse actual Boolean or quoted Boolean flags deliberately.

Original rationale:

```text
/**
 * Read the transcript's `is_error` flag.
 *
 * Today's transcripts write real JSON booleans: grepping the raw corpus finds
 * `"is_error":false` 38,075 times and `"is_error":true` 1,748, with no quoted
 * form at all. The boolean branch is the one that fires, and the string branches
 * are tolerated rather than required — cheap insurance against a vendor writing
 * the Python-style `"True"`/`"False"` on some future version.
 *
 * Deliberately not `Boolean(v)` even so. Were a quoted form ever to appear,
 * `Boolean("False")` is `true`, which would silently relabel every successful
 * call as an error — the kind of failure that reads as a real 96% error rate
 * rather than as a parse bug.
 *
 * Absent stays `undefined` rather than becoming `false`. `errorCoverage()`
 * counts a non-null `is_error` as "known", so guessing `false` here would
 * inflate coverage with 9,886 calls whose outcome was never recorded — the same
 * failure as costing an unpriced model at $0.
 */
```

## Note 223

Source: [bags/telemetry/src/usage/transcripts.ts](../../bags/telemetry/src/usage/transcripts.ts)

Match tool results by invocation identity rather than assuming adjacent transcript records.

Original rationale:

```text
/**
 * Pair every `tool_result` with the `tool_use` that caused it.
 *
 * The transcript carries no `duration_ms` field — I checked, and it is not there
 * under any spelling. What it does carry is a link: a `tool_result` record's
 * `parentUuid` points at the assistant record whose content array holds the
 * matching `tool_use` block, and that block is where the tool's NAME lives.
 * Both records are timestamped, so the duration is the delta between them.
 *
 * This resolves against the whole file rather than streaming, because a parent
 * is not guaranteed to be the immediately preceding line: parallel tool calls
 * interleave their results, and a resumed session replays earlier records. A
 * transcript is at most a few MB, so holding the uuid index is cheap.
 *
 * Over-ceiling samples are DROPPED, not clamped — the opposite of `elapsedMs`,
 * and the difference is worth stating. There, a missing point would read as "no
 * probe ran", so recording at the ceiling was the more honest of two imperfect
 * options. Here the row IS the claim: writing 300,000 ms asserts a five-minute
 * tool call that did not happen, and it would land in `toolDurations`' p95 and
 * max as if measured. The over-ceiling samples are not slow tools at all — they
 * cluster in `AskUserQuestion` (33% of its calls) and `ExitPlanMode` (48%),
 * which block on a HUMAN answering. Their duration is the user's lunch break.
 * Dropping loses 0.43% of samples and keeps the remaining 99.57% trustworthy;
 * clamping would keep a 185-row pile of fiction at exactly the ceiling.
 */
```

## Note 224

Source: [bags/telemetry/src/usage/transcripts.ts](../../bags/telemetry/src/usage/transcripts.ts)

Pricing uses per-million-token USD rates and distinguishes input, output and cache operations.

Original rationale:

```text
/**
 * Per-million-token prices, USD.
 *
 * Transcripts record tokens but no cost, so it is computed here. Kept as data
 * with an explicit `asOf` because prices change and a stale hardcoded number
 * would silently misreport spend — the figure would look measured while being
 * an artefact of whenever someone last edited this file.
 *
 * A model with no entry yields NO cost rather than a guessed one: an
 * unpriced model must read as "not costed", never as free.
 */
```

## Note 225

Source: [bags/telemetry/src/usage/transcripts.ts](../../bags/telemetry/src/usage/transcripts.ts)

Use the declared cache-write duration; five-minute and one-hour writes have different rates.

Original rationale:

```text
/**
 * Rates transcribed from the published pricing table, NOT derived. `cacheWrite`
 * is the 5-minute write (1.25x base input); the 1-hour write is 2x and is a
 * different number this table does not model, so a session using 1h caching is
 * under-costed on that component.
 *
 * Fable 5 is the standing counter-example to pricing by family resemblance: it
 * is 2x Opus on input and output, and its cache read is 1.0 — NOT the 0.1x
 * multiplier every other model here follows. Copying an Opus row would have
 * been wrong by 2x, and wrong by 10x on cache reads, while looking plausible.
 */
```

## Note 226

Source: [bags/telemetry/src/usage/transcripts.ts](../../bags/telemetry/src/usage/transcripts.ts)

Price only recorded usage components so omitted fields do not invent token counts.

Original rationale:

```text
/**
 * The parts of a usage record that pricing actually reads.
 *
 * Narrower than `TranscriptUsage` on purpose: cost depends only on a model and
 * four token counts, so a row read back from SQLite can be priced without
 * inventing a `requestId`/`ts` it no longer has (see `recostStoredRows`).
 * `TranscriptUsage` is assignable to this, so transcript callers are unchanged.
 */
```

## Note 227

Source: [bags/telemetry/src/tools.test.ts](../../bags/telemetry/src/tools.test.ts)

Exercise public tool outputs as well as shared read models so unavailable states survive serialization.

Original rationale:

```text
/**
 * Tool-level tests.
 *
 * Every handler is INVOKED, not merely imported. A tool that compiles, exports
 * cleanly and throws the moment it is called is the usual way a broken tool
 * ships — the type system cannot see a bad query or a missing table.
 *
 * The store-backed tools are asserted to report `unavailable` rather than
 * empty when a store cannot be opened. That distinction is the whole point:
 * "the store is unreachable" and "there was no activity this week" must
 * never arrive at a caller looking the same.
 *
 * This bag's vitest.config deliberately does not inherit vitest.base.config
 * (its tests live outside src/), so the base's scratch-store pins do NOT apply
 * here — without the overrides below, these suites would read the developer's
 * real stores. Read-only, but slow enough to trip timeouts, and a test of
 * whatever data happens to be on the machine.
 */
```

## Note 228

Source: [bags/telemetry/src/tools.test.ts](../../bags/telemetry/src/tools.test.ts)

Missing measurements must serialize as unavailable rather than a fabricated empty activity report.

Original rationale:

```text
/**
 * The check that matters most. If these ever start returning empty arrays
 * instead of `unavailable`, a caller reading the output would conclude Barry
 * had no activity — when in fact nothing was measured at all.
 *
 * The reason differs by panel, on purpose: the store-backed panels name the
 * missing file (a path problem), while unattributed calls carry the recorded
 * seam decision (a design problem). Both must be unavailable, and neither may
 * carry data.
 */
```

## Note 229

Source: [bags/telemetry/tools.ts](../../bags/telemetry/tools.ts)

MCP tools and dashboard reuse the same summaries to avoid divergent readings.

Original rationale:

```text
/**
 * Tools read the same summary functions the dashboard does.
 *
 * A tool and a dashboard that compute their answers separately eventually
 * disagree, and the disagreement is discovered during an incident — the worst
 * possible time to wonder which one is lying.
 */
```

## Note 230

Source: [bags/telemetry/tools.ts](../../bags/telemetry/tools.ts)

Periodic jobs are not long-running services; idle jobs must not appear dead.

Original rationale:

```text
/**
 * Is this label a periodic job rather than a long-running service?
 *
 * launchd reports no pid for a job that is waiting for its next interval. That
 * is healthy, so it must not be reported as down — only a service that is
 * supposed to be resident counts.
 */
```

## Note 231

Source: [bags/telemetry/tools.ts](../../bags/telemetry/tools.ts)

Return declared metrics alongside their observed values so uncollected metrics remain visible.

Original rationale:

```text
/**
 * What this bag collects, with the current value of each metric.
 *
 * The discovery entry point. `metrics query` needs an exact name, and before
 * this the only list of those names lived in that tool's schema description —
 * so a caller who mistyped one got an error listing 24 strings with no
 * indication of what any of them meant. This answers "what is measured?"
 * instead of assuming the caller already knows.
 *
 * Backs `/api/catalog` too, so the page and the tool cannot disagree about
 * which metrics exist.
 */
```

## Note 232

Source: [bags/telemetry/tools.ts](../../bags/telemetry/tools.ts)

A declared metric with no rows is unavailable, not a measured zero.

Original rationale:

```text
/**
             * A declared metric with no rows is a real state, and it is NOT the
             * same as a value of zero. `hostMemFreePct` has been in this schema
             * since the beginning and has never been collected — reporting it
             * as 0% free would be a fabricated reading of a catastrophic
             * condition. Say "never collected" instead.
             */
```

## Note 233

Source: [bags/telemetry/tools.ts](../../bags/telemetry/tools.ts)

Preserve ownership and observation windows when grouping session and message usage.

Original rationale:

```text
/**
 * Sessions and messages, by source, identity, repo, outcome and model.
 *
 * Every field is a `Panel` and is returned VERBATIM. Flattening an
 * `unavailable` panel to an empty array would make "the source is unreachable"
 * indistinguishable from "no sessions this week" — the exact confusion this
 * bag's own collectorOk metric exists to prevent.
 */
```

## Note 234

Source: [bags/telemetry/tools.ts](../../bags/telemetry/tools.ts)

Discover service warning/error evidence through the shared read models.

Original rationale:

```text
/**
 * Warnings and errors across Barry's services.
 *
 * Reads the bag-owned errors store, which the ingest job fills from service
 * logs before the supervisor rotates them away. This is the search surface that
 * went away with Axiom: `metrics query` answers "was it climbing", this
 * answers "what broke, and what did it say".
 */
```

## Note 235

Source: [bags/telemetry/tools.ts](../../bags/telemetry/tools.ts)

Correlate session evidence across stores without making absent data look complete.

Original rationale:

```text
/**
 * One session, across every store.
 *
 * The four stores each answer a different question and none of them answers
 * "what happened in this session". A cost spike, the errors that session
 * logged, and the HTTP traffic around it were three separate investigations
 * stitched together by hand; the join key existed the whole time and nothing
 * walked it.
 */
```

## Note 236

Source: [bags/telemetry/tools.ts](../../bags/telemetry/tools.ts)

The logs namespace reports measured structured logs independently of request timing.

Original rationale:

```text
/**
 * The `logs` namespace, reclaimed.
 *
 * It belonged to the axiom bag, whose vendor was removed from core -- ten tools
 * against a backend that no longer exists. That interface was proven, so these
 * keep its shape and point it at the local store.
 *
 * Deliberately a small subset of axiom's ten. `search` subsumes its
 * query/tail/context, and a tool that exists but answers nothing is worse than
 * one that was never offered.
 */
```

## Note 237

Source: [bags/telemetry/vitest.config.ts](../../bags/telemetry/vitest.config.ts)

Include root tool tests as well as src tests so the public tool contract is exercised.

Original rationale:

```text
/**
 * This bag keeps tests OUTSIDE `src/`, so it widens the shared base config's
 * include rather than using it as is.
 *
 * `vitest.base.config.ts` includes only `src/**‌/*.test.ts`. Two suites here
 * live elsewhere and were silently uncollected the moment the bag came in-repo
 * — `tools.test.ts` at the root (the MCP tool surface) and `web/spark.test.js`
 * (the dashboard's sparkline renderer, the bag's only JS test). 18 tests
 * disappeared without a single red run to say so, which is the failure mode
 * this file exists to prevent.
 *
 * Counted rather than assumed: the external checkout collected 31 files / 545
 * tests, and the first in-repo run collected 29 / 527. The two missing files
 * are exactly that difference.
 *
 * `.js` is in the pattern on purpose — dropping it silently drops spark.test.js.
 */
```

## Note 238

Source: [bags/telemetry/web/catalog.js](../../bags/telemetry/web/catalog.js)

Expose metric discovery and label dimensions without requiring a preselected series.

Original rationale:

```text
/**
 * Metric catalog — the discovery surface for everything this bag collects.
 *
 * Before this page the only way to chart a metric was to already know its exact
 * name: /api/series?metric= takes a string and nothing enumerated the strings.
 * The name list lived in schema.ts and in an MCP tool's schema description, so
 * a reader of the dashboard could not find it at all.
 *
 * Same constraints as the rest of this bag: no build step, no dependencies, and
 * it must keep working when the rest of Barry does not.
 */
```

## Note 239

Source: [bags/telemetry/web/catalog.js](../../bags/telemetry/web/catalog.js)

Persist catalog state in the URL so reloads and shared links keep their filters.

Original rationale:

```text
/**
 * State lives in the URL, not in a variable.
 *
 * A chart worth looking at is worth sending to someone, and back/forward should
 * work like every other page. Reading state from the querystring on load is
 * what makes both true.
 */
```

## Note 240

Source: [bags/telemetry/web/catalog.js](../../bags/telemetry/web/catalog.js)

Show every distinct label set so metric dimensions are discoverable.

Original rationale:

```text
/**
   * One chip per distinct label set, so the dimensions are discoverable too —
   * `latest` already returns one row per set, so this costs nothing extra.
   *
   * Sorted by value, descending, and scrollable: `barry.service.up` carries 27
   * label sets and `barry.service.runs` another 27. Rendered flat and unsorted
   * that is a wall of 27 identical-looking buttons, which is not discovery. The
   * interesting one is almost always the extreme, so put it first.
   *
   * Each chip carries its current value, which makes the row a comparison
   * across services rather than only a filter control.
   */
```

## Note 241

Source: [bags/telemetry/web/panels.js](../../bags/telemetry/web/panels.js)

Render contributed panels inside host-provided shells and preserve unavailable responses.

Original rationale:

```text
/**
 * Draws contributed panels into the shells the server rendered.
 *
 * Same constraints as every other script here: a module, no build step, no
 * dependencies. It shares `esc` and `schedulePolling` with the rest of the
 * dashboard so a contributed panel polls on the same cadence and escapes by the
 * same rules as a first-party one.
 *
 * Every state the host can be in has a distinct appearance, because the failure
 * this dashboard is built to prevent is a broken panel that looks healthy:
 *
 *   loading      — neutral, says which bag it is waiting on
 *   unavailable  — red bordered card naming the bag and the cause
 *   empty        — neutral text saying the query ran and found nothing
 *   partial      — data, under a warning strip carrying the caveat
 *   ok           — data
 *
 * `unavailable` and `empty` never share markup. If a contributor is stopped,
 * its panel turns red and says so; it does not quietly become a table with no
 * rows, which a reader would take as "nothing happened".
 */
```

## Note 242

Source: [bags/telemetry/web/spark.js](../../bags/telemetry/web/spark.js)

Share dashboard rendering and polling behavior so pages handle failure consistently.

Original rationale:

```text
/**
 * Shared rendering helpers for every metrics dashboard page.
 *
 * Extracted verbatim from index.html so the infra dashboard and the usage
 * dashboard draw from one implementation. Two pages with their own copy of a
 * sparkline renderer drift apart, and the drift is invisible until someone puts
 * them side by side.
 *
 * No build step, no dependencies — same constraint as the rest of this bag: the
 * dashboard for the thing that watches resource use should not itself pull in a
 * bundler and a watcher.
 */
```

## Note 243

Source: [bags/telemetry/web/spark.test.js](../../bags/telemetry/web/spark.test.js)

Stub the minimal DOM contract to test visibility-driven polling without a browser dependency.

Original rationale:

```text
/**
 * `schedulePolling` reads `document.visibilityState` and listens for
 * `visibilitychange` — the whole point of it. This repo has no jsdom/happy-dom
 * dependency (the dashboard is deliberately dependency-free, see spark.js's own
 * header), so this stubs the minimal `document` surface the function actually
 * touches rather than pulling in a DOM implementation for one helper.
 */
```

## Note 244

Source: [bags/telemetry/web/spark.test.js](../../bags/telemetry/web/spark.test.js)

Back off failed polling up to the ceiling so a struggling server is not hammered at base cadence.

Original rationale:

```text
/**
   * Backoff: a `refresh` that keeps throwing must not keep retrying at the
   * base cadence — this dashboard polling a server that is already struggling
   * once a second is the wrong failure mode. Doubling up to the ceiling is the
   * behaviour under test; a flat "call count over time" assertion could pass
   * by accident, so this checks calls line up with the DOUBLING schedule,
   * not just that there were fewer of them.
   */
```
