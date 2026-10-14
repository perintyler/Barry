# ADR 0005: Telemetry storage and metric invariants

## Context

Source narratives explain metric semantics, SQLite performance and failures that led to the current regression tests. These retained notes preserve the comment-pass checkpoint rather than claim fresh measurements.

## Decision

Retain the complete rationale here and put the controlling invariant beside each implementation or test. No executable behavior changes in the move.

## Consequences

Metric and retention changes must preserve units, unavailable states, tier completeness and transactional writes. Historical timings below are evidence for the decision, not present performance guarantees.

## Note 105

Source: [bags/telemetry/src/sampler.test.ts](../../bags/telemetry/src/sampler.test.ts)

Record zero notification attempts on a quiet tick so idle differs from unobserved.

Original rationale:

```text
/**
   * A quiet tick must still record `attempts: 0`.
   *
   * Writing these only when something was sent leaves the series empty in two
   * opposite states — "nothing needed alerting" and "the sampler is dead" —
   * which is the ambiguity these metrics exist to remove, and it makes
   * `metrics_catalog` report them as never collected on a host that simply has
   * not alerted lately. This shipped in the first cut of the fix, guarded by
   * `deliveries.length > 0`, and is the same latch `ollamaLoadedMb` documents.
   */
```

## Note 106

Source: [bags/telemetry/src/sampler.test.ts](../../bags/telemetry/src/sampler.test.ts)

Measure the complete sampler tick so slow rule evaluation and maintenance remain visible.

Original rationale:

```text
/**
   * `samplerMs` brackets `sample()` only, so everything after it — the write,
   * ~20 rule evaluations, notification, maintenance — was outside the number
   * that `sampler-expensive` watches. It averaged 2.3s over 24h while jobs.db
   * recorded 26.4s for the same job and a 441s peak against a 60s interval.
   *
   * The tick metric has to be at least the collection metric, always: it is the
   * outer bracket around the same work. Asserting the ORDER rather than a
   * duration keeps this honest on a fast machine where both round to the same
   * few milliseconds.
   */
```

## Note 107

Source: [bags/telemetry/src/sampler.ts](../../bags/telemetry/src/sampler.ts)

A tick contains collection, writes, rule evaluation, delivery and maintenance failures independently.

Original rationale:

```text
/**
 * One sampler tick: collect, store, evaluate, alert, maintain.
 *
 * Ordering matters. Points are written BEFORE rules are evaluated so a rule
 * can see the sample that triggered it, and maintenance runs last so a slow
 * rollup never delays an alert.
 */
```

## Note 108

Source: [bags/telemetry/src/sampler.ts](../../bags/telemetry/src/sampler.ts)

Evaluate shipped and registered rules together so extensions participate in the same state machine.

Original rationale:

```text
/**
   * Rules to evaluate. Defaults to the shipped set plus anything registered.
   *
   * Injectable for the same reason `db` and `now` are: a test that wants to
   * assert on the tick's own behaviour must not have its result decided by
   * whatever happens to be wrong with the host.
   *
   * That was not hypothetical. A test asserting "nothing was sent this tick"
   * called `tick()` with no rule fixture, so it passed only on a machine with
   * no firing alerts — and failed deterministically the moment
   * `mcp-transport-leak` fired legitimately at 63% of its ceiling. Two sessions
   * spent an hour establishing that the code was correct and the machine was
   * merely busy. A test that makes two careful readers compare notes to
   * conclude "nothing is wrong" has negative value.
   *
   * Pass `[]` for "evaluate nothing", which is a real and distinct request from
   * "evaluate the defaults and hope they stay quiet".
   */
```

## Note 109

Source: [bags/telemetry/src/sampler.ts](../../bags/telemetry/src/sampler.ts)

Difference cumulative CPU counters over elapsed time; counter resets must not produce negative utilization.

Original rationale:

```text
/**
 * Turn cumulative CPU seconds into interval CPU percent.
 *
 * The collector records `barry.service.cpu_sec`, monotonic since exec. The
 * percentage is the difference between two consecutive samples over the wall
 * time between them — which is the only form that can answer "is this service
 * hot NOW".
 *
 * What this replaces: `ps` %CPU, a lifetime average. It reported the metrics
 * sampler at 35.7% while the job actually used ~600ms per 60s tick (~1%), a
 * ~35x error. And the error is not random — it is anti-correlated with the
 * condition the metric exists to detect, because a long-healthy process dilutes
 * any fresh spike.
 *
 * Three cases deliberately write NO point rather than a zero:
 *   - no previous sample (first tick after a restart): 0 would read as "idle"
 *     when the truth is "not yet known".
 *   - a counter that went backwards: the process restarted, so the two readings
 *     are from different lifetimes and their difference is meaningless.
 *   - a zero or negative time span: no interval, no rate.
 *
 * Not clamped to 100: on a multi-core host 200 means two cores saturated, and
 * clamping would hide exactly the runaway worth seeing.
 */
```

## Note 110

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Keep metric names, units and label contracts shared by collectors and consumers.

Original rationale:

```text
/**
 * The metric contract.
 *
 * One shape for everything: a named number, at a time, with dimensions.
 * Adding a metric is a new string, never a migration — which matters because
 * this store exists to watch for unbounded growth and must not become an
 * instance of it.
 *
 * Names are dotted and hierarchical (`barry.service.restarts`), dimensions go
 * in labels (`{"service":"api"}`) rather than into the name. That split is what
 * lets a query ask "restarts across all services" and "restarts for api" without
 * knowing which services exist.
 */
```

## Note 111

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Cumulative warn/error counts distinguish ingestion progress from an empty interval.

Original rationale:

```text
/**
   * Cumulative warn/error events ingested into the errors store, per service.
   *
   * Cumulative on purpose: like `barry.service.runs`, the signal is the DELTA.
   * A gauge of "errors right now" is zero between incidents and says nothing
   * about a service that failed 200 times an hour ago, which is precisely the
   * question Axiom's error-spike monitor existed to answer.
   *
   * Labelled by service and level ONLY. Not by message, session or request:
   * one series per distinct error would mint a new series on every new failure
   * and never retire it — the unbounded growth this store exists to detect.
   * The message text lives in errors.db, which is built for it.
   */
```

## Note 112

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

CPU seconds are cumulative across the supervised process tree.

Original rationale:

```text
/**
   * Cumulative CPU seconds since exec, summed over the supervised tree.
   *
   * Recorded raw and monotonic so the percentage can be DIFFERENCED between two
   * samples. That is the only honest way to ask "is it hot now": `ps` %CPU is a
   * lifetime average, so it reported the metrics sampler — a job using roughly
   * 600ms per 60s tick, about 1% — at 35.7%. Worse than imprecise, it is
   * anti-correlated with the wedge it was declared to catch, because the longer
   * a service has been healthy the more a fresh spike is diluted.
   */
```

## Note 113

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Derive interval utilization from cumulative CPU readings; do not chart the raw counter as percent.

Original rationale:

```text
/**
   * Interval CPU percent, derived by differencing `serviceCpuSec`.
   *
   * A service pinned near 100 is the "wedged but answering" shape — a spun
   * event loop still accepts the connection, so a 200 from the health probe
   * proves nothing on its own.
   *
   * No point is written for the first sample after a restart, because there is
   * no predecessor to difference against and a 0 there would read as "idle"
   * rather than "not yet known". Percentages can exceed 100 on a multi-core
   * host: 200 means two cores saturated, and that is deliberately not clamped.
   */
```

## Note 114

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Free physical pages differ from process RSS and cached memory.

Original rationale:

```text
/**
   * Free physical memory as a share of all pages, from `vm_stat`.
   *
   * Was declared here long before anything collected it; the sampler does write
   * it now. Read it alongside the compressor and swap metrics rather than
   * alone — macOS runs with little "free" memory by design, so a low value here
   * is normal and only means something when the other two agree.
   */
```

## Note 115

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Compressor share measures host pressure independently of any single process footprint.

Original rationale:

```text
/**
   * Share of physical memory held by the compressor.
   *
   * The EARLY signal that swap is not. macOS compresses before it swaps, so
   * this rises first; by the time swap is large the machine is already paging.
   * On this box the compressor was holding 50GB of data in 6.7GB of RAM (~7.4x)
   * while swap sat at 16GB — the pressure was visible here long before the
   * swap number became alarming.
   */
```

## Note 116

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Wired kernel memory cannot be paged or compressed; process-only rankings cannot account for it.

Original rationale:

```text
/**
   * Share of physical memory that is WIRED — kernel memory that can never be
   * paged out or compressed.
   *
   * Parsed by `parseVmStat` since the beginning and thrown away until now, which
   * is why the 2026-08-25 memory investigation concluded "structural, nothing to
   * fix": summed RSS was 5.95GB against 15GB in use, and 7.2GB of the difference
   * was sitting here, invisible. Wired is the floor under every other number —
   * whatever it holds is memory the remaining processes can never get.
   */
```

## Note 117

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Vnode counts describe kernel allocation; their allocation ratio alone is not pressure evidence.

Original rationale:

```text
/**
   * Vnodes in use — the kernel's cache of open filesystem objects.
   *
   * **`num == max` IS THE NORMAL STATE. Do not write a saturation rule on this.**
   *
   * One was written, on the reasoning that 247,213 of 247,213 looked like a
   * cache pinned against its ceiling. The data says otherwise: across 111
   * samples the value had exactly ONE distinct reading, and during a window in
   * which wired memory moved 3.5GB the vnode count did not shift by a single
   * unit. macOS sizes the vnode table to `kern.maxvnodes` and reclaims entries
   * lazily, so the count rises to the ceiling and stays there — it measures the
   * table's size, not pressure against it.
   *
   * The rule was deleted rather than retuned. A rule that cannot go green is
   * indistinguishable from a broken one and trains people to ignore the channel.
   *
   * Kept as a metric because the PAIR still carries information a future reader
   * may want: if `vnodes_max` ever changes, someone retuned the kernel, and
   * these two series are the record of when.
   */
```

## Note 118

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Footprint rankings include non-Barry processes so external consumers of host memory remain visible.

Original rationale:

```text
/**
   * Real memory footprint of the heaviest processes on the box, Barry's or not,
   * labelled `{name, rank}`.
   *
   * Exists because RSS lied and no per-service metric could have caught it: the
   * two largest consumers were a virtualization helper VM (292MB by RSS, 4,661-6,137MB in
   * truth — a 21x understatement) and an ollama runner at 4,030MB. Neither is a
   * Barry service, so a metric scoped to Barry would have reported a healthy
   * machine while the box swapped itself to a standstill.
   *
   * Bounded to the top 12 by footprint. One series per PID across ~772 processes
   * would mint a new series on every process restart and never retire it, which
   * is the unbounded growth this store exists to detect.
   */
```

## Note 119

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

The whole-tick duration includes rule evaluation, notification and maintenance.

Original rationale:

```text
/**
   * How long the whole tick took: collect, write, evaluate rules, notify, maintain.
   *
   * `samplerMs` measures only `sample()`. Everything after it — writing points,
   * evaluating ~20 rules, dispatching notifications, running maintenance — was
   * outside the number, so the metric that exists to catch "the monitor became
   * expensive" could not see the expensive part.
   *
   * Measured: `samplerMs` averaged 2.3s over 24h while the same job averaged
   * 26.4s in jobs.db and peaked at 441s against a 60s interval. One run printed
   * `ms=20326` while `sampler-expensive` fired on `10925` — two durations for
   * one tick, with the rule watching the smaller. launchd started the next tick
   * while the previous was still running, which is where the store's 479
   * duplicate (labels, ts) pairs came from.
   *
   * Monotonic like the rest: wall clock advances while the host sleeps.
   */
```

## Note 120

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Record collector health explicitly so failed commands do not look like empty readings.

Original rationale:

```text
/**
   * 1 when a required command was found and ran, 0 when it could not.
   *
   * Exists because a missing binary is INVISIBLE otherwise: `sh` treats a
   * failed command as absence (an unloaded launchd label legitimately prints
   * nothing), so when launchd's minimal PATH omitted /usr/sbin the swap and
   * port collectors quietly recorded zero rows while the sampler reported
   * success. "No data" and "broken" must not look identical.
   */
```

## Note 121

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Use daemon-reported resident model size rather than inferring it from a process name.

Original rationale:

```text
/**
   * Resident size of loaded models, from `/api/ps`.
   *
   * Recorded as an UNLABELLED TOTAL that is an explicit 0 when nothing is
   * loaded, not only as per-model series. A per-model series simply STOPS when
   * its model unloads, and a series that goes silent rather than reporting a
   * low value cannot satisfy an alert's clearLimit — the exact latch that kept
   * `process-footprint-outsized` firing on an exited process for a week.
   */
```

## Note 122

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Expiry is daemon time minus observation time, distinct from model activity.

Original rationale:

```text
/**
   * Seconds until Ollama unloads the model (`expires_at` minus now).
   *
   * Explains spawn churn: keep_alive is 60s, so a model reloads on most ticks
   * and pays a ~3s cold start plus a 4-6GB allocation each time. Negative or
   * absent means nothing is loaded.
   */
```

## Note 123

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Report summary parse success separately from the values parsed.

Original rationale:

```text
/**
   * 1 when the summary line parsed, 0 when it did not.
   *
   * The honesty metric for everything above it. Those are parsed out of another
   * repo's log format; if that format changes, every counter here would chart a
   * flat zero and read as "the job ran and did nothing" — indistinguishable
   * from a healthy quiet period. This is what makes the difference visible.
   */
```

## Note 124

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Metric timestamps are UNIX seconds throughout storage and retention.

Original rationale:

```text
/**
   * Unix SECONDS, not milliseconds — stored verbatim by `writePoints`.
   *
   * Spelled out because getting it wrong fails silently in the direction that
   * looks like success: a millisecond window bound matches no rows and reads as
   * "no data" rather than as an error.
   */
```

## Note 125

Source: [bags/telemetry/src/schema.ts](../../bags/telemetry/src/schema.ts)

Retain raw recent data and bounded hourly history so monthly trends remain answerable.

Original rationale:

```text
/**
 * Retention, chosen so the store stays bounded without losing the ability to
 * answer the question that matters: "was this climbing all month?"
 *
 * Raw is kept long enough to debug something that happened overnight; hourly
 * rollups are kept long enough to see a slow leak's slope. Anything older is
 * noise at this sampling rate.
 */
```

## Note 126

Source: [bags/telemetry/src/server.test.ts](../../bags/telemetry/src/server.test.ts)

Exercise dashboard handlers directly so routes, response shapes and authentication stay testable.

Original rationale:

```text
/**
 * Route-level tests for the dashboard server.
 *
 * The server had no test at all before this: the route table, the static-asset
 * allowlist and the nav on every page were all unverified, so adding a page or
 * a link could not break anything. Several of the defects these cover had
 * already shipped — the landing page carried no nav, and the tab order had
 * drifted between pages.
 *
 * Runs the real server against a temp database on an ephemeral port, so the
 * developer's own ~/.barry/metrics.db is never read or written.
 */
```

## Note 127

Source: [bags/telemetry/src/server.test.ts](../../bags/telemetry/src/server.test.ts)

Use a raw socket to verify wire behavior that fetch normalizes away.

Original rationale:

```text
/**
   * Sent over a raw socket, NOT through fetch().
   *
   * fetch() resolves `..` in the client before the request leaves, so
   * `fetch("/../../../../etc/passwd")` puts `/etc/passwd` on the wire and the
   * server never sees a traversal at all. A version of this test written with
   * fetch() passed against a server whose allowlist had been replaced by
   * `join(webDir, url.pathname)` — it proved nothing. An attacker writes the
   * bytes directly, so the test has to as well.
   */
```

## Note 128

Source: [bags/telemetry/src/server.ts](../../bags/telemetry/src/server.ts)

Serve the metrics dashboard from its owning store without depending on session API availability.

Original rationale:

```text
/**
 * Metrics dashboard.
 *
 * Plain node:http with no framework and no build step. The dashboard for the
 * thing that watches resource use should not itself pull in a dependency tree,
 * a bundler and a watcher — and it must keep working when the rest of Barry
 * does not.
 *
 * Binds loopback only; where else it is reachable is the installation's
 * hosting policy. A tunnel connects from loopback like everything else, so
 * the pages and their API need the instance secret or a browser session from
 * the sign-in page (@barry-rocks/sdk/auth); only /health and the
 * static assets, which hold no data, are open.
 */
```

## Note 129

Source: [bags/telemetry/src/server.ts](../../bags/telemetry/src/server.ts)

Serve only explicitly cataloged assets rather than joining arbitrary request paths.

Original rationale:

```text
/**
 * Files servable from web/, keyed by request path.
 *
 * Shared by every dashboard page so the validated palette and the sparkline
 * renderer exist once. Two pages with their own copy of a colour ramp drift
 * apart, and the drift is invisible until they are seen side by side.
 */
```

## Note 130

Source: [bags/telemetry/src/server.ts](../../bags/telemetry/src/server.ts)

Reopen SQLite after database replacement so a long-running server does not retain the old inode.

Original rationale:

```text
/**
 * Reopen the database when the file on disk is replaced.
 *
 * SQLite handles follow the INODE, not the path. A handle opened at boot keeps
 * serving a file that has since been unlinked — so if the db is deleted and
 * recreated (a reset, a restore, a botched maintenance), this long-lived
 * server goes on answering from a snapshot that stopped updating, showing
 * stale alerts with a fresh "last sample" time. That is the worst kind of
 * wrong: confidently, invisibly out of date.
 *
 * Cheap to check — one stat per request — and it keeps the dashboard honest
 * without a restart.
 */
```

## Note 131

Source: [bags/telemetry/src/server.ts](../../bags/telemetry/src/server.ts)

Read contributions once at boot so request handling does not repeatedly scan manifests.

Original rationale:

```text
/**
 * Panels other bags contributed, read once at boot.
 *
 * Read once rather than per request because a contribution is a declaration
 * made when a bag is enabled, not something that changes under a running
 * dashboard — and a file read on every page load would be a syscall per
 * request for data that almost never differs. The panel's DATA is fetched per
 * request; only the list of panels is cached.
 */
```

## Note 132

Source: [bags/telemetry/src/server.ts](../../bags/telemetry/src/server.ts)

Resolve contributor addresses through installed service identity, without assuming a fixed port.

Original rationale:

```text
/**
 * How a contributed panel's base URL is resolved.
 *
 * Always the resource registry, never a port this repo knows — that registry
 * exists precisely so the host need not know about any specific bag, and a
 * hardcoded port here would put a second bag's address back into this one's
 * source.
 *
 * The path is overridable only so an end-to-end test can stand up a real
 * contributor against a registry of its own rather than writing into the live
 * one. Unset — which is every real deployment — it reads the real registry.
 */
```

## Note 133

Source: [bags/telemetry/src/server.ts](../../bags/telemetry/src/server.ts)

Batch series reads while retaining each metric’s label identity.

Original rationale:

```text
/**
     * Several series in one request.
     *
     * The dashboard draws a sparkline per stat tile and polls every 15s; four
     * separate round trips per refresh would be four times the work for data
     * that is always read together.
     */
```

## Note 134

Source: [bags/telemetry/src/server.ts](../../bags/telemetry/src/server.ts)

Expose the metric catalog alongside readings so absent series remain discoverable.

Original rationale:

```text
/**
     * What this bag collects.
     *
     * Exists because every other read route demands an exact metric name and
     * nothing enumerated them: /api/series?metric= is unusable unless you have
     * already read schema.ts. Same payload as the `metrics catalog` tool, from
     * the same source, so the page and the tool cannot disagree about which
     * metrics exist.
     */
```

## Note 135

Source: [bags/telemetry/src/server.ts](../../bags/telemetry/src/server.ts)

An explicit asset allowlist prevents traversal and accidental source-file exposure.

Original rationale:

```text
/**
     * Static assets, by an explicit allowlist rather than a path join.
     *
     * `join(HERE, "..", "web", url.pathname)` would be the obvious shape and is
     * a directory traversal: a request for /../../.ssh/id_rsa escapes the web
     * directory. This server binds loopback, but "not reachable today" is not a
     * security boundary. A fixed map cannot traverse anywhere.
     */
```

## Note 136

Source: [bags/telemetry/src/server.ts](../../bags/telemetry/src/server.ts)

Usage panels are asynchronous because their read models query other owning stores.

Original rationale:

```text
/**
     * Usage panels. Async because of the read models they query, unlike every
     * route above, which reads local SQLite synchronously.
     *
     * Never throws to the client: each panel carries its own ok/empty/
     * unavailable/partial state, so one dead source degrades that panel rather
     * than blanking the page. `window` is clamped rather than rejected — a
     * dashboard should not 400 at a reader who typed a number.
     */
```

## Note 137

Source: [bags/telemetry/src/server.ts](../../bags/telemetry/src/server.ts)

Proxy contributor data with bounded failures so a missing bag does not break the host page.

Original rationale:

```text
/**
     * One contributed panel's data, proxied from the bag that contributed it.
     *
     * The host fetches rather than the browser, for two reasons. The panel's
     * service binds loopback and is not reachable from the page's origin at
     * all; and going through here means the four Panel states are validated
     * once, server-side, instead of trusting whatever a contributor's endpoint
     * put on the wire.
     *
     * `fetchPanel` has no rejection path — an unreachable, hung, erroring or
     * malformed contributor all resolve to `unavailable` with a reason — so
     * this route answers 200 with a stated failure rather than 500 with none.
     * A 500 here would render as "the dashboard is broken" when the truth is
     * "one contributor is down", and that is the confusion this bag exists to
     * prevent.
     */
```

## Note 138

Source: [bags/telemetry/src/store.test.ts](../../bags/telemetry/src/store.test.ts)

Latest-value queries must avoid a correlated timestamp lookup per candidate row.

Original rationale:

```text
/**
     * The dashboard outage of 2026-08-25.
     *
     * `latest` used a correlated scalar subquery keyed on `labels`, but the only
     * index is (metric, ts) and does not cover labels — so each evaluation rescans
     * every row of the metric. On the live db one call measured 16.3s at 92% CPU
     * (19.8s with the rows rebuilt into a fresh table, so it was the data shape and
     * not file fragmentation). /api/overview calls latest() eight times and the page
     * polls every 15s, so requests arrived faster than they finished: the server
     * pegged a core for 4d21h and stopped answering entirely.
     *
     * Verified on the real rows: 19.8s before, 0.128s after, with EXCEPT returning
     * zero difference between the two result sets.
     */
```

## Note 139

Source: [bags/telemetry/src/store.ts](../../bags/telemetry/src/store.ts)

Keep metric writes transactional and retention bounded in the owning SQLite store.

Original rationale:

```text
/**
 * SQLite-backed metric store.
 *
 * Deliberately boring: two tables, no ORM, no background threads. The store
 * that watches for runaway resource use should be the least surprising thing
 * on the box.
 *
 * WAL is on so a sampler write never blocks a dashboard read — the web app and
 * the launchd job hit this file concurrently by design.
 */
```

## Note 140

Source: [bags/telemetry/src/store.ts](../../bags/telemetry/src/store.ts)

Insert each point batch atomically so one sampler observation cannot be partly recorded.

Original rationale:

```text
/**
 * Insert a batch of points in one transaction.
 *
 * `p.ts` is UNIX SECONDS and is stored verbatim — no conversion happens here,
 * so a caller passing `Date.now()` writes timestamps a thousandfold in the
 * future and every window query then silently misses them. Build the value with
 * `Math.floor(Date.now() / 1000)`, as the collectors do.
 */
```

## Note 141

Source: [bags/telemetry/src/store.ts](../../bags/telemetry/src/store.ts)

Return exactly one latest row per label set without a correlated aggregate for every candidate.

Original rationale:

```text
/**
 * Most recent value per label set for a metric. Exactly one row per label set.
 *
 * The window function is not a micro-optimization — it replaces a correlated
 * subquery (`ts = (SELECT MAX(ts) ... WHERE labels = p.labels)`) that took this
 * dashboard down on 2026-08-25. That form is re-evaluated per candidate row and
 * cannot use the (metric, ts) index for its `labels` predicate, so it rescans
 * every row of the metric each time: 19.8s for one call on 49,619 rows, against
 * 0.128s here. /api/overview calls this eight times and the page polls every 15s,
 * so the server pegged a core for 4d21h and stopped serving.
 *
 * It was also WRONG. When several label sets share the same newest ts — which is
 * what happens when services stop and their final samples collapse onto one tick —
 * the old predicate matched rows across label sets and returned duplicates (83 rows
 * where there are 23 label sets). One row per label set has to be structural.
 *
 * ## Why this is now a GROUP BY and not that window function
 *
 * The window function was correct and, at 49,619 rows, fast. It does not stay
 * fast: it materializes and sorts EVERY row of the metric to return one row per
 * label set, so its cost tracks total history rather than series count. At
 * 1,141,564 rows that is 10.4s for a single call. `firingAlerts` calls it once
 * per rule across ~20 rules, so /api/overview took 79-142s while /health kept
 * answering in milliseconds — the dashboard was effectively down behind a green
 * health check.
 *
 * Grouping to one `max(ts)` per label set and joining back reads one group per
 * series instead of sorting the whole history: 0.14s for the same call, and
 * /api/overview's three calls fall from ~206s to ~3.5s. Verified against the
 * window form on all 64 live metrics — every returned row sits at its series'
 * true `max(ts)`, and no label set is returned twice.
 *
 * The first attempt at this WAS a correlated subquery again, and store.test.ts
 * caught it: 34s against its 3s budget, on the fixture built specifically for
 * this failure. The test's own comment predicted it — a naive fixture "would
 * have certified the bug as fixed while it was still there". The second attempt
 * grouped `max(ts)` and `max(rowid)` together, which is wrong whenever the
 * highest rowid is not the newest row: it returned two stale rows on live data.
 * Hence the join on `(labels, ts)` with the tie-break applied after.
 *
 * A time bound was tried first and REJECTED. Bounding to 1h or 24h is faster
 * still, but it silently drops series that are legitimately stale — a job last
 * sampled 104 hours ago vanishes rather than reporting as old. `isStale` in
 * rules.ts exists to judge exactly those rows and cannot judge what it never
 * receives, so the bound would have hidden the staleness the rules are for.
 * Absence must stay distinguishable from "not collected".
 *
 * ## Ties
 *
 * The remaining 3 of 64 metrics differ because the store holds 479 duplicate
 * (labels, ts) pairs — the 60s `sample` and 300s `footprint` ticks can observe a
 * short-lived job at different instants inside the same second, and two of those
 * pairs disagree about whether it was up. SQLite's bare-column rule leaves which
 * row wins unspecified, so BOTH the old and new forms were already arbitrary
 * there. `max(rowid)` makes the winner the last row written, which is at least
 * deterministic and reproducible across reads. The collision itself is a
 * collector bug, tracked separately; this only stops it reading as flapping.
 */
```

## Note 142

Source: [bags/telemetry/src/store.ts](../../bags/telemetry/src/store.ts)

Read hourly buckets oldest first so charts preserve chronological order.

Original rationale:

```text
/**
 * Hourly rollups for a metric, oldest first.
 *
 * The counterpart to `queryPoints`. Raw points only survive
 * `RETENTION.rawDays` (7); everything older lives here as hourly buckets for
 * 90 days. A reader that consults only one of the two tables sees a fraction of
 * the history it asked for — see `series()`.
 *
 * Returns `avg` as the value. For a gauge that is the honest summary of an
 * hour; for a monotonic counter it is not, but no caller charts a raw counter
 * (the dashboard charts its DELTA), and `min`/`max`/`last` are kept in the table
 * for a caller that needs them.
 */
```

## Note 143

Source: [bags/telemetry/src/store.ts](../../bags/telemetry/src/store.ts)

Roll up before deleting raw points so retention never discards the only retained reading.

Original rationale:

```text
/**
 * Fold raw points into hourly buckets, then drop the raw rows that were folded.
 *
 * Only fully-elapsed hours are rolled up: summarizing the current hour would
 * write a partial bucket and then delete the points needed to complete it.
 *
 * Rollup and delete share one transaction — a crash between them would either
 * double-count on retry or lose the window entirely.
 */
```

## Note 144

Source: [bags/telemetry/src/store.ts](../../bags/telemetry/src/store.ts)

Maintain rollups, pruning and reclamation together so bounded retention releases disk space.

Original rationale:

```text
/**
 * Full maintenance pass: roll up, prune, and reclaim.
 *
 * The VACUUM matters more than it looks. Without it SQLite keeps the freed
 * pages, so the file only ever grows — the store would slowly become the
 * disk-growth problem it was built to detect.
 */
```

## Note 145

Source: [bags/telemetry/src/summary.test.ts](../../bags/telemetry/src/summary.test.ts)

Retain service-versus-job kind so an idle periodic job is not reported as a dead service.

Original rationale:

```text
/**
   * REGRESSION — `kind` was dropped between the collector and the summary, so a
   * periodic job was indistinguishable from a dead service. `up` is false for a
   * job almost always (no pid between runs), which painted 14 of 28 dashboard
   * rows permanently red: an indicator that stays red whether or not anything is
   * wrong cannot report a problem.
   *
   * Fails against a summary that does not carry `kind` through.
   */
```

## Note 146

Source: [bags/telemetry/src/summary.test.ts](../../bags/telemetry/src/summary.test.ts)

Detect supervisor counter resets instead of reporting negative restarts.

Original rationale:

```text
/**
   * launchd's run counter is monotonic only within one load. Unloading and
   * reloading a job restarts it from a lower number, so `last - first` goes
   * negative — which is what produced the reported "restartsLastHour: -2".
   *
   * Suppressing the delta matters more than it looks: a negative restart count
   * does not read as an error, it reads as a service that is doing fine.
   */
```

## Note 147

Source: [bags/telemetry/src/summary.test.ts](../../bags/telemetry/src/summary.test.ts)

Scheduled starts are healthy job executions; they are not resident-service restarts.

Original rationale:

```text
/**
   * A 60s interval job increments this counter on every firing by design, so
   * ~56/hour is healthy. The count is still reported — callers distinguish jobs
   * from resident services by name — but it must not be called "restarts": that
   * framing led to the metrics sampler being reported as crash-looping at "55
   * restarts/hour" when launchd showed 6,133 runs all exiting 0.
   */
```

## Note 148

Source: [bags/telemetry/src/summary.test.ts](../../bags/telemetry/src/summary.test.ts)

Long windows must read both raw and hourly tiers rather than silently returning recent days only.

Original rationale:

```text
/**
   * The store keeps history in two tiers: raw for 7 days, hourly rollups for 90
   * after that. `series` used to read only raw, so a 30-day request returned 6.9
   * days of data and looked complete — the older weeks sat unread in
   * rollup_hourly. A silently short chart is worse than an error, because the
   * question the 90-day retention exists to answer ("was this climbing all
   * month?") gets a confident answer about the last week.
   */
```

## Note 149

Source: [bags/telemetry/src/summary.ts](../../bags/telemetry/src/summary.ts)

Share read models between dashboard and MCP tools so both report the same evidence.

Original rationale:

```text
/**
 * Read models shared by the web app and the MCP tools.
 *
 * Kept out of both so a question is answered identically whether asked from a
 * browser or from a session — a dashboard and a tool that disagree are worse
 * than either alone.
 */
```

## Note 150

Source: [bags/telemetry/src/summary.ts](../../bags/telemetry/src/summary.ts)

Distinguish resident services from periodic jobs when interpreting liveness.

Original rationale:

```text
/**
   * `"service"` for a resident process, `"job"` for a periodic one.
   *
   * The collector has always labelled this; the summary used to discard it, and
   * `up` was read as liveness for both. A job has no pid between runs, so all 14
   * of them rendered permanently red — an indicator that is red whether or not
   * anything is wrong, which is the failure this bag exists to catch.
   */
```

## Note 151

Source: [bags/telemetry/src/summary.ts](../../bags/telemetry/src/summary.ts)

Current process liveness does not describe whether a periodic job ran successfully.

Original rationale:

```text
/**
   * Whether a process is alive RIGHT NOW.
   *
   * Only meaningful for `kind: "service"`. For a job this is false almost always
   * and says nothing — `job.backup` runs once a day and is legitimately absent
   * the other 86,395 seconds. Judge a job by its exit status and last run time,
   * not by this.
   */
```

## Note 152

Source: [bags/telemetry/src/summary.ts](../../bags/telemetry/src/summary.ts)

Interpret launchd starts within the selected window, accounting for reload resets.

Original rationale:

```text
/**
   * Launchd starts within the last hour.
   *
   * Named `runs`, not `restarts`, because the counter behind it counts
   * INVOCATIONS. For a resident service those are restarts and the crash-loop
   * signal; for a 60s interval job they are just the schedule doing its job, and
   * ~56/hour is healthy. Calling it "restarts" led a reader to diagnose the
   * metrics sampler as crash-looping when launchd's own record showed 6,133 runs all
   * exiting 0. Use `kind` to tell them apart, as the service-restart-loop rule
   * does with labelIn.
   *
   * `undefined` when the window has no data; never negative — see below.
   */
```

## Note 153

Source: [bags/telemetry/src/summary.ts](../../bags/telemetry/src/summary.ts)

A counter decrease marks a reset, not negative activity.

Original rationale:

```text
/**
   * True when the counter went BACKWARDS across the window.
   *
   * launchd's run count is monotonic only within one load: unloading and
   * reloading a job resets it, so `last - first` goes negative and rendered as
   * "restartsLastHour: -2". A negative restart count is not just noise — it reads
   * as healthy, which is worse than a missing number. The delta is suppressed and
   * this flag is set so the UI can say "counter reset" instead of showing a
   * subtraction of two unrelated counter generations.
   */
```

## Note 154

Source: [bags/telemetry/src/summary.ts](../../bags/telemetry/src/summary.ts)

Keep static rule rationale separate from the current readings that caused a firing.

Original rationale:

```text
/**
   * STATIC prose explaining why the rule exists — fixed at authoring time and
   * identical on every firing.
   *
   * Named for what it is because the old name, `rationale`, sat beside the live
   * `text` and read as evidence gathered about THIS firing. It carries figures
   * from the 2026-08-25 investigation ("the 4,030MB ollama runner"), and a
   * reader who took those for current measurements was reading a machine state
   * that had not existed for two weeks. Any number in here is history.
   */
```

## Note 155

Source: [bags/telemetry/src/summary.ts](../../bags/telemetry/src/summary.ts)

Merge raw and rollup history so a downsampled chart spans the requested window.

Original rationale:

```text
/**
 * A downsampled series for charting, spanning both storage tiers.
 *
 * Reads rollups AND raw points, because the store keeps history in two places:
 * raw for `RETENTION.rawDays` (7), hourly buckets for 90 days after that. This
 * function used to read only `metric_point`, so a 30-day request silently
 * returned 6.9 days — the chart looked complete and the older three weeks sat
 * unread in `rollup_hourly`. A truncated series with no gap marker is worse than
 * an error: nothing about it looks wrong, and "was this climbing all month?" —
 * the question the 90-day retention exists to answer — got a confident answer
 * about the last week instead.
 *
 * The two sources are contiguous by construction: `rollup()` folds a bucket and
 * deletes its raw rows in one transaction, so nothing is both rolled up and raw,
 * and nothing falls between them. Concatenating cannot double-count.
 *
 * Buckets to at most `points` values so a 90-day window returns a readable
 * series instead of a hundred thousand rows the browser must then throw away.
 */
```

## Note 156

Source: [bags/telemetry/src/usage/errors.test.ts](../../bags/telemetry/src/usage/errors.test.ts)

Distinguish scanned lines from inserted rows, including after truncation.

Original rationale:

```text
/**
   * The distinction the two-number result exists for, and the post-truncation
   * case specifically.
   *
   * A log rotated away is replaced by a new, smaller file under the same name.
   * It is below the stored byte offset, `resolveStartOffset` resets to 0, and
   * the file is re-read from its start. A pass that finds only rows already
   * stored is perfectly healthy and inserts NOTHING.
   *
   * Reporting only inserts would print 0 there, which is exactly what a
   * collector reading a path that no longer exists also prints. `read` is what
   * separates them.
   */
```

## Note 157

Source: [bags/telemetry/src/usage/errors.test.ts](../../bags/telemetry/src/usage/errors.test.ts)

Offsets count bytes, not characters, so multibyte log messages cannot corrupt resumption.

Original rationale:

```text
/**
 * Byte offsets.
 *
 * This store re-read every source from byte 0 on every pass for its whole
 * life — correct, because of the content-hash id, but O(file size) where its
 * two siblings are O(new bytes). These pin the fix.
 */
```

## Note 158

Source: [bags/telemetry/src/usage/errors.test.ts](../../bags/telemetry/src/usage/errors.test.ts)

An incomplete final line must remain unread until its terminating newline arrives.

Original rationale:

```text
/**
   * The rule that matters most, and the one a naive implementation gets wrong.
   *
   * `readline` yields whatever trails the final newline even when it is a
   * half-written record. Counting those bytes into the stored offset means the
   * next pass starts reading AFTER them, and the rest of that record — once
   * the writer finishes it — is never seen. That is strictly worse than the
   * old re-scan-everything behaviour, which at least lost nothing.
   */
```

## Note 159

Source: [bags/telemetry/src/usage/errors.ts](../../bags/telemetry/src/usage/errors.ts)

Ingest structured warning/error events independently of request timing telemetry.

Original rationale:

```text
/**
 * Error and warning events, parsed from the services' pino logs into local
 * SQLite.
 *
 * ## Why this is not a metric
 *
 * The metrics store answers "was it climbing". This answers "what broke, and
 * what did it say" — which needs the message text, and `metric_point.value` is
 * a REAL with nowhere to put one. Forcing `sessionId` or `requestId` into
 * `labels` to compensate would mint a series per session: the unbounded-growth
 * shape that store exists to detect, not to contain.
 *
 * So this is a sibling store, exactly like `requests.db`, for the same reason:
 * one shape per question.
 *
 * ## Why a snapshot rather than reading the logs live
 *
 * The log files are not a store. The supervisor rotates a service's log once
 * it passes 10MB and keeps only a few rotations. Ingesting incrementally means
 * the SQLite copy survives that; reading the files directly would silently
 * show less and less.
 *
 * ## Why tailing, not pushing
 *
 * Services could emit here directly, but the bag's collectors are deliberately
 * external — a sampler still reports when a service is wedged, while an
 * in-process emitter goes silent exactly when you need it. Tailing also means
 * no service changes, no second SQLite writer, and no way for this to block or
 * crash the thing it is observing.
 *
 * This replaced Axiom, which held the same stream until 2026-09. Its ingest
 * had been failing silently for a while (unawaited, and over a column ceiling
 * the logger grew into), which is its own argument for a local store with no
 * network in the path.
 */
```

## Note 160

Source: [bags/telemetry/src/usage/errors.ts](../../bags/telemetry/src/usage/errors.ts)

Normalize volatile identifiers so equal error shapes group together without losing event evidence.

Original rationale:

```text
/**
 * Collapse a message to its stable shape for grouping.
 *
 * Barry's operational events are already dotted identifiers
 * (`sessions.persist_message_failed`), so most messages need nothing. Free-text
 * messages get their embedded ids and numbers flattened, otherwise every
 * occurrence looks like a distinct error and "top errors" says nothing.
 */
```

## Note 161

Source: [bags/telemetry/src/usage/errors.ts](../../bags/telemetry/src/usage/errors.ts)

Resume at byte offsets and apply the watermark without rereading the whole file each pass.

Original rationale:

```text
/**
 * Ingest a log file, resuming from its stored byte offset and skipping
 * anything before the watermark.
 *
 * `INSERT OR IGNORE` on a deterministic id makes a re-run harmless.
 *
 * ## This used to re-read the whole file every pass, and requests.ts did not
 *
 * `requests.ts` stored a byte offset per file and seeked to it, so a pass cost
 * the NEW bytes. This one opened every source from byte 0 on every run —
 * ~5.9MB across 20 files, every 300s, ~288 times a day, roughly 1.7GB of
 * redundant reads a day. The `INSERT OR IGNORE` on a content-hash id kept that
 * correct, so the cost was wasted reads rather than duplicate rows, and at
 * ~450ms a pass it was never an incident.
 *
 * It was worth fixing because the two costs scale differently: that one was
 * O(file size) and grew with the logs, the other is O(new bytes) and does not.
 * **That gap is now closed**: this seeks to `resolveStartOffset(...)` like its
 * two siblings, and a pass costs the appended bytes.
 *
 * The offset is deliberately not the ONLY guard. `resolveStartOffset` resets it
 * to 0 on rotation, truncation or corruption, and when that happens this
 * necessarily re-reads lines already stored. The watermark filter — and
 * `INSERT OR IGNORE` on the content-hash id — is what makes that harmless: a
 * full re-read after a reset cannot duplicate rows already captured, exactly as
 * it always could before offsets existed. That is what makes a reset safe, and
 * it is why `resolveStartOffset` is free to answer 0 whenever it cannot trust
 * the stored value.
 */
```

## Note 162

Source: [bags/telemetry/src/usage/errors.ts](../../bags/telemetry/src/usage/errors.ts)

A terminating newline confirms the last log record is complete.

Original rationale:

```text
/**
 * Whether the file's last byte is a newline — i.e. whether its final line is
 * confirmed complete rather than a write still in progress.
 *
 * Read directly from the fd rather than inferred from the stream, because
 * readline strips the separator and so cannot tell "ended with a newline" from
 * "ended mid-line".
 */
```

## Note 163

Source: [bags/telemetry/src/usage/errors.ts](../../bags/telemetry/src/usage/errors.ts)

Discover supervised service logs dynamically rather than maintaining a stale name list.

Original rationale:

```text
/**
 * Every service log on this machine, discovered rather than listed.
 *
 * Deliberately not a hardcoded list. The requests collector carries one, and it
 * still names `apps/web/barry.works/logs/` — a path that stopped existing when
 * that app became a bag, so that source has silently ingested nothing since.
 * Globbing the launchd log directory cannot go stale that way: a new bag
 * service appears here the first time it writes a line.
 */
```

## Note 164

Source: [bags/telemetry/src/usage/errors.ts](../../bags/telemetry/src/usage/errors.ts)

Emit cumulative per-service severity counts so subsequent samples can measure ingestion progress.

Original rationale:

```text
/**
 * Cumulative event counts per (service, level), for the metrics store.
 *
 * Emitted from here rather than sampled from the services, because this is the
 * only place that already knows the counts — and because a count derived from
 * the same rows the search surface reads cannot disagree with it. Two
 * collectors counting the same thing separately is how a dashboard and an
 * alert come to tell different stories during an incident.
 */
```
