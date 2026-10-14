# ADR 0003: Telemetry collector invariants

## Context

Long source comments mixed operating constraints with incident narratives. The notes below preserve the original rationale from the comment-pass checkpoint; incident counts and dates describe that observation, not a current measurement.

## Decision

Keep a short invariant beside each collector and regression test. Preserve the supporting reasoning here, linked from the source. No collector behavior changes in this move.

## Consequences

Future collector changes must review the linked rationale as well as their tests. Historical observations below are evidence for the decision, not an assertion that the old fault still exists.

## Note 001

Source: [bags/telemetry/logs/src/index.ts](../../bags/telemetry/logs/src/index.ts)

Logging writers depend on the shared format; collection belongs to the parent bag.

Original rationale:

```text
/**
 * The `logs` sub-bag: the store that holds log lines with a per-level TTL.
 *
 * The format and the emitters are in the kit (`@barry-rocks/sdk/logging`),
 * since every bag writes log lines and none should depend on this bag to do
 * it. Collection is not here either: `ingestLog`, `defaultLogSources`, the
 * `ingest-logs` job and the read models live in the parent bag.
 */
```

## Note 002

Source: [bags/telemetry/logs/src/store.ts](../../bags/telemetry/logs/src/store.ts)

Keep schema and retention together; a logs sub-bag must never depend on its collector parent.

Original rationale:

```text
/**
 * The logs store: schema, retention policy, and the prune that enforces it.
 *
 * ## Why the store lives in the sub-bag with the format
 *
 * Schema and retention are ONE artifact. `RETENTION_DAYS` names horizons per
 * level; `prune` deletes by them; the DDL below is what they operate on. Split
 * across two packages, a retention change lands in one and a schema change in
 * the other with nothing forcing agreement — the same shape of split that let
 * the emitter and the parser drift apart for months.
 *
 * ## What is deliberately NOT here
 *
 * COLLECTION. `ingestLog`, `defaultLogSources`, the `ingest-logs` job and the
 * read models (`coverage`, `search`, `volume`, `services`) stay in the parent
 * bag, which imports this module. That keeps the dependency that `engine` and
 * twelve other logging packages take to: a format, an emitter, and a store —
 * never an ingest job. A broken collector cannot break a process that only
 * wanted to write a log line.
 *
 * Parent -> child is the sanctioned direction here and the reason sub-bags
 * exist. Do not invert it: a sub-bag must never reach up into its container.
 */
```

## Note 003

Source: [bags/telemetry/logs/src/store.ts](../../bags/telemetry/logs/src/store.ts)

Evaluate severity bands first so debug volume does not dictate error retention.

Original rationale:

```text
/**
 * How long each level is kept, in days.
 *
 * Evaluated most-severe first: the first threshold a row meets decides its
 * horizon.
 *
 * A uniform horizon would either discard errors while they are still being
 * investigated, or keep a week of debug chatter to do it. Info is a firehose
 * whose value decays in hours; an error matters until someone has looked at it.
 */
```

## Note 004

Source: [bags/telemetry/logs/src/store.ts](../../bags/telemetry/logs/src/store.ts)

The caller owns the WAL handle; telemetry accepts NORMAL durability and uses UNIX seconds.

Original rationale:

```text
/**
 * Open the store (creating it if needed) and migrate it; the caller owns the
 * handle. WAL so the web app reads while a job writes; a busy timeout because
 * more than one process writes (the ingest job, and anything that prunes);
 * `synchronous = NORMAL` because this is telemetry, not a ledger, and FULL
 * costs an fsync per write. Every time column is UNIX SECONDS.
 */
```

## Note 005

Source: [bags/telemetry/logs/src/store.ts](../../bags/telemetry/logs/src/store.ts)

Disjoint severity bands prune each row once; report deleted counts even when zero.

Original rationale:

```text
/**
 * Drop rows past their level's horizon.
 *
 * Returns the count deleted per band, so a sweep that removed nothing is
 * distinguishable from one that never ran -- the same reason the notify metrics
 * write a zero.
 *
 * The banding is subtle and load-bearing: bands are sorted most-severe first,
 * and each band's UPPER bound is the previous band's `minLevel`, so a row is
 * pruned by exactly one horizon. Changing the sort or the bound silently
 * applies the wrong retention to a whole level.
 */
```

## Note 006

Source: [bags/telemetry/src/alert-events.ts](../../bags/telemetry/src/alert-events.ts)

Durable alert events let other bags react without coupling delivery to the sampler.

Original rationale:

```text
/**
 * Recording an alert as a Barry event, so other bags can react to it.
 *
 * ## Why alerts and not errors
 *
 * The obvious move is to turn every row in the errors store into an event, and
 * it is wrong. Measured on this machine: 327 errors a day against 110 events,
 * and 272 of those 327 were ONE broken thing — a supervisor tick failing with
 * the same database error 179 times. Events are a human-facing surface that can
 * trigger a notifier, so that import would bury the feed under repeats of a
 * single fault.
 *
 * The deduplication already exists. `error-spike` is delta-based and
 * edge-triggered, so those 179 rows are one firing. Alerts are the errors
 * store's own summary of itself, and they are what a subscriber actually wants
 * to know.
 *
 * It is also the only honest thing to send onward. An `error_event` row is a
 * parsed log line with no stack and no breadcrumbs, arriving up to a tail
 * interval late — strictly worse than what a service's own Sentry SDK already
 * reported. An alert is a DERIVED condition with no exception anywhere, so
 * nothing else can report it at all.
 *
 * ## Over HTTP, and best-effort
 *
 * This runs in a launchd job, not in the API, so it posts. The alert has
 * already been delivered to Slack by the time this runs and `alert_state`
 * already holds the firing, so a failure here loses a notification to other
 * bags and nothing else. It must never fail the tick — but it is also never
 * silent, because a recorder that quietly stopped would leave every subscriber
 * looking at a feed that is simply empty.
 */
```

## Note 007

Source: [bags/telemetry/src/alert-events.ts](../../bags/telemetry/src/alert-events.ts)

Record firing evidence separately from delivery so a failed channel cannot erase the alert.

Original rationale:

```text
/**
 * Record one firing.
 *
 * `severity: "error"` for critical and `"warn"` otherwise, matching the
 * vocabulary events already use rather than inventing a third scale — a
 * subscriber filtering on severity should not have to learn this bag's.
 *
 * The rule id and labels go in `data` rather than being formatted into the
 * title: a hook fingerprinting on the rule wants the id as a field, and
 * re-parsing it out of a sentence is how that breaks the first time someone
 * rewords a message.
 */
```

## Note 008

Source: [bags/telemetry/src/alert-events.ts](../../bags/telemetry/src/alert-events.ts)

Recovery events retain the firing identity so downstream consumers can correlate the transition.

Original rationale:

```text
/**
 * Record one recovery.
 *
 * Sent for the same reason the Slack all-clear is: a subscriber that only ever
 * hears about firings cannot tell a problem that persists from one that was
 * fixed an hour ago, which is precisely what made the un-sent recoveries a bug
 * worth fixing in the first place.
 */
```

## Note 009

Source: [bags/telemetry/src/collect-bookkeeping.ts](../../bags/telemetry/src/collect-bookkeeping.ts)

Read bookkeeping output from durable action runs, independently of whether the process remains alive.

Original rationale:

```text
/**
 * Session bookkeeping, read out of the run store.
 *
 * ## Why parse a log line instead of asking the job
 *
 * The bookkeeping job lives in the other repo (`bags/sessions`) and already
 * writes everything worth having — how many entries it wrote, how many model
 * calls failed, the latency spread — as the final stdout line of each run. It
 * runs as the `sessions/bookkeeping` schedule, and the scheduler stores that
 * stdout on the run in actions.db. (It used to be `output_tail` in
 * ~/.barry/jobs.db; reading that after the move would have returned the last
 * pre-migration row forever — metrics frozen at one value, looking healthy.)
 *
 * The cost is a coupling to someone else's text format, and the mitigation is
 * `bookkeepingParseOk`: if the format moves, that reads 0 instead of every
 * counter quietly reading 0, which would look exactly like a job that ran and
 * found nothing to do.
 *
 * ## What the line looks like, and how it varies
 *
 * On a run that wrote something:
 *
 *   done considered=19 written=8 named=2 drifted=0 failed=0 \
 *     model(n=8 p50=19.9s max=29.6s) skipped(no_new_messages=5 tick_write_cap=131)
 *
 * On a run that wrote nothing — the MAJORITY, 38 of the last 60 ticks — the
 * `model(...)` group is absent entirely, because there were no calls to
 * measure. Absent latency is therefore normal and must NOT read as a parse
 * failure. `skipped(...)` keys vary in order and presence.
 */
```

## Note 010

Source: [bags/telemetry/src/collect-bookkeeping.ts](../../bags/telemetry/src/collect-bookkeeping.ts)

Only a recognized summary line is evidence of a completed bookkeeping result.

Original rationale:

```text
/**
 * Parse the summary line.
 *
 * Returns null when the line is not a bookkeeping summary at all — that is what
 * drives `parse_ok=0`. A line that IS a summary but simply made no model calls
 * parses fine with `p50Sec: null`; treating that as failure would report a
 * broken parser on most healthy runs.
 */
```

## Note 011

Source: [bags/telemetry/src/collect-bookkeeping.ts](../../bags/telemetry/src/collect-bookkeeping.ts)

Use the most recent finished run; an in-flight run has no complete summary.

Original rationale:

```text
/**
 * Read the most recent finished bookkeeping run.
 *
 * Only closed runs: the row exists from the moment the run starts, and an
 * in-flight run has no output yet — which would parse as a break rather than
 * as "not finished yet".
 */
```

## Note 012

Source: [bags/telemetry/src/collect-hooks.test.ts](../../bags/telemetry/src/collect-hooks.test.ts)

Use the instance API and its credential; a wrong port must not masquerade as a healthy scrape.

Original rationale:

```text
/**
 * These three are the regression tests for the bug that shipped: the collector
 * pointed at the DEV api port with no credential, so it reported
 * `collectorOk = 0` for sixty consecutive ticks and looked exactly like an API
 * that was simply down. The old suite passed throughout, because its fetch stub
 * ignored the URL and the headers — the two things that were wrong.
 */
```

## Note 013

Source: [bags/telemetry/src/collect-hooks.test.ts](../../bags/telemetry/src/collect-hooks.test.ts)

Collector health and failure reason are separate signals; a zero alone cannot identify the repair.

Original rationale:

```text
/**
 * The zero is not the whole signal.
 *
 * Each of these conditions reported an identical `collectorOk = 0`, so an
 * alert could say the collector was broken but never which repair to make —
 * a missing BARRY_SECRET in a job manifest and a stopped API presented the
 * same. That is the hazard this collector's own comments describe and then
 * reproduced. The `reason` label is what tells them apart.
 */
```

## Note 014

Source: [bags/telemetry/src/collect-hooks.ts](../../bags/telemetry/src/collect-hooks.ts)

Scrape hook counters from their owning API so silent hook failures become observable.

Original rationale:

```text
/**
 * Record-hook activity, pulled from the API that runs the hooks.
 *
 * A bag can declare `hooks.barry` in its manifest and have its script run when
 * a Barry event is created. Everything about that path is designed to be
 * survivable — the hook runs in a spawned process, its failure is contained so
 * it cannot break the write that triggered it, and the event is durable either
 * way. Which means a hook that stops running changes nothing anyone would
 * notice. These points are what make that noticeable.
 *
 * ## Pull, not push
 *
 * The API could write these itself, and must not: metrics.db has a single
 * writer by design (see collect-ollama.ts) and a second writing process loses
 * points to SQLITE_BUSY, which charts as a gap, which is indistinguishable from
 * idle. So the API exposes counters and this pulls them, the same shape used
 * for Ollama.
 *
 * ## Why `dispatches` matters more than `failures`
 *
 * Failures can only be counted while dispatch still happens. If the seam itself
 * breaks — the API stops registering its dispatcher, the events bag stops
 * calling it — the failure count stays flat at whatever it was, and flat reads
 * as healthy. `dispatches` is incremented for EVERY event, including ones no
 * bag hooked, so it going quiet is the signal. That is what
 * `hook-dispatch-silent` watches.
 *
 * Both counters are cumulative and reset when the API restarts. The rules read
 * deltas, so a restart reads as a pause rather than a negative number.
 */
```

## Note 015

Source: [bags/telemetry/src/collect-hooks.ts](../../bags/telemetry/src/collect-hooks.ts)

Bound loopback hook reads to one second to keep a hung API from exhausting the base tick.

Original rationale:

```text
/**
 * Short on purpose. This runs on the 60s base tick, whose whole budget is
 * ~600ms, and the endpoint is a loopback read of two in-memory numbers — if it
 * has not answered in a second the API is wedged, which is what
 * `collectorOk{tool:"hooks"}` is for. The longer 4s used by the health probes
 * is for services that do real work per request.
 */
```

## Note 016

Source: [bags/telemetry/src/collect-hooks.ts](../../bags/telemetry/src/collect-hooks.ts)

Emit collector health on every scrape so an unavailable API differs from zero hook activity.

Original rationale:

```text
/**
 * Collect record-hook counters.
 *
 * Always reports `collectorOk{tool:"hooks"}`, 1 or 0 — the contract that keeps
 * the rest readable. Without it, "the API is down" and "no hooks have run"
 * would both be an absence of points, and the `no-data` rule would fire for a
 * stopped API rather than for a broken seam.
 *
 * A failing point additionally carries `reason`, because the zero alone cannot
 * say whether to edit a manifest or restart a service. See `failed()` below.
 *
 * When the API is unreachable, NO counter points are emitted at all. Emitting a
 * zero would be worse than saying nothing: the counters are cumulative, so a
 * zero is a decrease, and the delta rules would read it as the count going
 * backwards on every failed scrape.
 */
```

## Note 017

Source: [bags/telemetry/src/collect-hooks.ts](../../bags/telemetry/src/collect-hooks.ts)

Distinguish missing configuration, transport, HTTP and malformed responses for actionable repairs.

Original rationale:

```text
/**
   * A failure, and WHICH failure.
   *
   * The four ways this collector can fail are four different jobs for whoever
   * reads the alert: `unconfigured` is a manifest missing BARRY_SECRET and is
   * fixed by editing bag.yaml; `unreachable` is the API being down; `http` is
   * it answering and refusing us, which at 403 means the secret is wrong rather
   * than absent; `malformed` is the endpoint's contract having changed under
   * us. Collapsing them was this collector's own documented hazard -- the
   * comment below notes a 403 would be "indistinguishable from the API being
   * down", and the secret guard added to prevent that then emitted the same
   * indistinguishable zero it was meant to prevent.
   *
   * The reason rides as a LABEL on the existing metric rather than as a new
   * metric, because `collector-broken` already fires on any
   * `barry.collector.ok` below 1 and keeps doing so untouched -- the label only
   * tells the reader which repair to make. `collect-ollama.ts` needs no
   * equivalent: it scrapes an anonymous endpoint with no secret to be missing,
   * so reachable-or-not really is the whole question there.
   */
```

## Note 018

Source: [bags/telemetry/src/collect-ollama.ts](../../bags/telemetry/src/collect-ollama.ts)

Measure the local Ollama daemon separately from Barry supervisor-owned services.

Original rationale:

```text
/**
 * Ollama, sampled into the local store.
 *
 * ## Why this bag has to reach outside Barry to find it
 *
 * Ollama is the largest memory consumer Barry causes and, until this collector,
 * the only one attributed to nobody. Service discovery lists only Barry's own
 * supervised services, and Ollama is a login item outside that scope — while its
 * `llama-server` child holds 4-6GB per inference on a 16GB machine.
 *
 * Barry does NOT own its lifecycle: it is a login item, and the one caller
 * (session bookkeeping, every 15 minutes) degrades to log-and-skip when it is
 * absent. This collector measures; it does not manage.
 *
 * ## Pull, not push
 *
 * `/api/ps` reports what is loaded right now, so nothing has to cooperate with
 * this bag to be measured. That matters more than convenience: metrics.db has a
 * single writer by design — `usage/telemetry.ts` documents why it needs no
 * busy_timeout — and a second writing process would lose points to SQLITE_BUSY,
 * which charts as a gap, which is indistinguishable from idle.
 */
```

## Note 019

Source: [bags/telemetry/src/collect-ollama.ts](../../bags/telemetry/src/collect-ollama.ts)

Keep the local Ollama port here to avoid a cross-bag package dependency for one constant.

Original rationale:

```text
/**
 * Ollama's fixed local port.
 *
 * Restated rather than imported from the sessions bag, which lives in the other
 * repo: a cross-repo `link:` dependency is heavier coupling than the one line
 * it would save.
 */
```

## Note 020

Source: [bags/telemetry/src/collect-ollama.ts](../../bags/telemetry/src/collect-ollama.ts)

Track the selected bookkeeping model so an accidental larger-model swap is observable.

Original rationale:

```text
/**
 * The model session bookkeeping needs.
 *
 * qwen3:4b was chosen over qwen3:8b on measured evidence — same drift accuracy,
 * ~3x faster, 4.1GB against 6.6GB resident. Tracking WHICH model is loaded is
 * the point: a swap back to 8b would quietly cost 2.5GB on a machine that
 * cannot spare it.
 */
```

## Note 021

Source: [bags/telemetry/src/collect-ollama.ts](../../bags/telemetry/src/collect-ollama.ts)

A request timeout contains hangs; allSettled alone only contains rejected requests.

Original rationale:

```text
/**
 * Per-request ceiling.
 *
 * `Promise.allSettled` in `sample()` contains a REJECTION, not a hang: a daemon
 * that accepts the connection and never answers would stall the whole tick, and
 * the sampler's own `sampler-expensive` rule fires at 10s. Matches the 3s probe
 * the bookkeeping job already uses.
 */
```

## Note 022

Source: [bags/telemetry/src/collect-ollama.ts](../../bags/telemetry/src/collect-ollama.ts)

Fixture-tested parsing distinguishes malformed daemon responses from idle models.

Original rationale:

```text
/**
 * Parse `/api/ps`.
 *
 * Exported for tests: the shapes that matter (loaded, idle, malformed) are
 * cheaper and more reliable to assert against fixtures than against a live
 * daemon whose model unloads after 60 seconds.
 */
```

## Note 023

Source: [bags/telemetry/src/collect-ollama.ts](../../bags/telemetry/src/collect-ollama.ts)

Always emit collector health; zero loaded models alone cannot distinguish idle from stopped.

Original rationale:

```text
/**
 * Collect Ollama state.
 *
 * Always returns `collectorOk{tool:"ollama"}`, 1 or 0. That is the contract that
 * makes the rest of these numbers readable: a quit Ollama and an idle Ollama
 * both have zero models loaded, so without this point `loaded_mb = 0` would mean
 * both "nothing to do" and "not running" — the failure this bag exists to catch.
 */
```

## Note 024

Source: [bags/telemetry/src/collect.test.ts](../../bags/telemetry/src/collect.test.ts)

A Claude MCP-config argument does not make the Claude process an MCP server.

Original rationale:

```text
/**
   * A Claude session carries `--mcp-config .../barry-mcp-XXXXXX/mcp.json` in its
   * argv, so an `-mcp\b` substring rule classified all 14 live sessions as
   * `mcp-server` and summed their RSS there. Measured 2026-08-25: reported 16
   * servers holding 2,521MB when exactly ONE Barry MCP server was running at
   * 18MB, while `claude-session` undercounted 14 as 9.
   *
   * Both directions matter. A real leak in the MCP server would have been
   * invisible under the sessions' RSS, and a phantom 2.5GB leak reported
   * forever — the classifier had no test on this branch at all.
   */
```

## Note 025

Source: [bags/telemetry/src/collect.test.ts](../../bags/telemetry/src/collect.test.ts)

Label readings by collecting job so overlapping ticks cannot collide at one timestamp.

Original rationale:

```text
/**
   * sample, footprint and sweep all run the same host and service collectors,
   * and every interval is a multiple of 60, so they are SCHEDULED to start in
   * the same second on a fixed cadence -- ~64 collisions a day measured. With
   * `ctx.now` stamped once per tick, two overlapping ticks wrote ~206 points
   * each under one identical timestamp: 3,781 duplicate groups, 632 of them
   * holding CONFLICTING values (rss differing by up to 154MB).
   *
   * The label is what makes two real readings two series instead of a
   * collision.
   */
```

## Note 026

Source: [bags/telemetry/src/collect.test.ts](../../bags/telemetry/src/collect.test.ts)

Scrape record hooks only on the base tick to prevent duplicate health series.

Original rationale:

```text
/**
   * The record-hook scrape belongs to the BASE tick alone.
   *
   * It was called unconditionally while only the `sample` manifest declares
   * BARRY_SECRET, so every footprint and sweep tick took the no-secret path and
   * wrote `collectorOk{tool:"hooks"} = 0`. Measured over one hour that was
   * 10-of-10 failures on footprint against a seam that was working the whole
   * time, and the fix is the gate rather than adding the secret to two more
   * manifests: those jobs have no reason to hold a credential they only spend
   * on a collector that should not run there.
   *
   * Asserted on the POINT's absence rather than its value, so this stays honest
   * whether or not the API happens to answer while the suite runs.
   */
```

## Note 027

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Contain each collector failure and identify the collecting job on every emitted point.

Original rationale:

```text
/**
 * Sampling collectors.
 *
 * Every collector shells out to a macOS tool and parses the result. Two rules
 * shape this file:
 *
 * 1. A collector that throws must never take the sample down. One broken
 *    parser should cost one metric, not the whole tick — so each is wrapped
 *    and its failure recorded rather than propagated.
 * 2. Cost is the point. This runs every 60s on a box that has been at 91%
 *    swap, so it prefers one batched `ps` over per-process calls, and it
 *    records its own duration (barry.sampler.ms) so an expensive monitor is
 *    visible in its own output.
 */
```

## Note 028

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Resolve collector tools by absolute path because supervised jobs inherit a minimal PATH.

Original rationale:

```text
/**
 * Absolute paths to every tool a collector shells out to.
 *
 * Not resolved from PATH. launchd gives a job a minimal environment —
 * measured here as `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, which
 * omits /usr/sbin, where both sysctl and lsof live. Under that PATH the swap
 * and port-ownership collectors silently produced nothing while the sampler
 * reported success, because `sh` treats a failed command as absence rather
 * than as an error. A monitor must not depend on ambient environment.
 */
```

## Note 029

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Supervisor status owns service ports; discovery must not assume default instance ports.

Original rationale:

```text
/**
 * Port ownership from supervisor status.
 *
 * The supervisor reports a squat directly as state `conflict`, so the complex
 * inference polling launchd required is no longer needed.
 *
 * Returns 1 (ours), 0 (squatted), or null (unknown/irrelevant — record
 * nothing).
 */
```

## Note 030

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Clamp reported elapsed time without claiming to cancel the underlying operation.

Original rationale:

```text
/**
 * Elapsed milliseconds from a `performance.now()` mark, clamped to `ceilingMs`.
 *
 * Two separate defences against the same bug. `Date.now()` is wall clock, and
 * wall clock advances while the host SLEEPS: `barry.health.ms` recorded a
 * maximum of 1,068,680ms — 17.8 minutes — against a probe that aborts itself at
 * 4s, and 35 of 13,067 readings exceeded 100,000ms. The probe did not take 17
 * minutes; the laptop was shut.
 *
 * These readings do not merely look wrong, they poison every aggregate that
 * includes one: a 24h mean for the API came out at 2,359ms against a true ~30ms.
 * So every reader needed a `value < 100000` guard, and anyone who forgot got
 * nonsense.
 *
 * `performance.now()` is monotonic and does not advance across system sleep,
 * which fixes the cause. The clamp is belt-and-braces for any platform where
 * that does not hold: a value cannot exceed the operation's own timeout, so
 * anything above it is definitionally an artifact and is recorded AT the
 * ceiling rather than dropped — a missing point would read as "no probe ran".
 */
```

## Note 031

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Keep free, compressed and wired physical pages distinct; process RSS cannot explain kernel pressure.

Original rationale:

```text
/**
 * Parse `vm_stat` -> { freePct, compressorPct, wiredPct, wiredMb }.
 *
 * Percentages rather than raw page counts: page size differs by architecture
 * (16KB on Apple silicon, 4KB on Intel), so a count means nothing on its own.
 *
 * `wiredMb` is the exception, and it is why the page size is parsed from
 * vm_stat's own header rather than assumed. A hardcoded 4096 on Apple silicon
 * would understate wired memory by 4x — and a wrong number here is worse than
 * none, because wired is the floor under every other memory reading. If the
 * header is missing the whole parse returns null instead of guessing.
 */
```

## Note 032

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Cumulative CPU seconds are a counter; derive utilization from successive readings.

Original rationale:

```text
/**
   * Cumulative CPU seconds consumed by this process since exec.
   *
   * The honest basis for "is it hot NOW": differenced between two samples it
   * gives real interval CPU. `cpu` above cannot do that — it is diluted by the
   * whole lifetime, so a service wedged at 100% for ten minutes after ten days
   * idle reads near zero. It is ANTI-correlated with the wedge it claims to
   * detect: the longer a service has been healthy, the more a new spike is
   * hidden.
   */
```

## Note 033

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Process grouping must distinguish a session with MCP arguments from an MCP server.

Original rationale:

```text
/**
 * Classify a process into the group it should be counted under.
 *
 * Attribution matters more than the count. `caffeinate` is the worked example:
 * 6-10 concurrent is NORMAL — each Claude Code session spawns a renewing one —
 * so counting them as anonymous "extra processes" would page every day. They
 * get their own bucket where a plausible number is visibly plausible.
 */
```

## Note 034

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Identify the collecting job so equal timestamps from different schedules remain distinct.

Original rationale:

```text
/**
   * Which job is doing the collecting.
   *
   * `sample`, `footprint` and `sweep` all call tick() and so run the same host
   * and service collectors. Their intervals are 60s, 300s and 3600s -- every
   * one a multiple of 60 -- so they are SCHEDULED to start in the same second
   * on a fixed cadence, ~64 times a day measured. `ctx.now` is stamped once per
   * tick at its start, so two overlapping ticks wrote ~206 points each under
   * one identical timestamp.
   *
   * That produced 3,781 duplicate (metric, labels, ts) groups, 632 of them with
   * CONFLICTING values -- two genuine readings a second apart, rss differing by
   * up to 154MB and health latency by 682ms. Both correct; the store could not
   * tell them apart because the distinguishing information was discarded at
   * write time.
   *
   * Labelling by job is what restores it. Two jobs measuring the same thing are
   * two series, and pretending otherwise is what created the collision.
   *
   * `samplerMs` has been labelled `mode` for this reason since it was written
   * ("the heavy sweep legitimately takes longer"); this generalises that from
   * one metric to the collectors that actually collide.
   */
```

## Note 035

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Count descendants under their supervising ancestor to avoid omitting child-process memory.

Original rationale:

```text
/**
 * Is `pid` the same as, or a descendant of, `ancestor`?
 *
 * Port ownership cannot be a PID equality check. Every service whose plist
 * runs `pnpm exec tsx ...` has launchd supervising the pnpm wrapper while a
 * grandchild holds the socket — measured live: launchd supervises 26452
 * (`pnpm exec`), the listener is 26501 (`node server/src/index.ts`), and that
 * is a perfectly healthy service.
 *
 * The real fault is a listener that is NOT in the supervised tree: an orphan
 * that outlived its parent, reparented to PID 1, still holding the port while
 * launchd starts a replacement that dies EADDRINUSE.
 */
```

## Note 036

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Use footprint values from top rather than summing overlapping process RSS.

Original rationale:

```text
/**
 * Parse `top -l 1 -o mem -stats pid,mem,command` -> Map<pid, MB>.
 *
 * The MEM column is the compressed-aware footprint, which is the whole point:
 * `ps` RSS reported a virtualization helper process at 292MB while this
 * reported 4,661-6,137MB, a 21x understatement, because RSS cannot see
 * compressed or ballooned pages.
 *
 * Keyed by PID and never by name. `top` truncates COMMAND to 15 characters
 * ("com.apple.Virtua", "Slack Helper (Re") and -ncols does not widen it, so the
 * name is a display label only — joining on it would silently mismatch.
 *
 * Returns null, NEVER an empty Map, when no row parses. An empty Map would flow
 * onward and write nothing, which is indistinguishable from a machine with no
 * processes; null lets the caller record that the collector itself is broken.
 */
```

## Note 037

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Keep host memory and service footprints separate; shared pages make summed RSS misleading.

Original rationale:

```text
/**
 * Real memory footprint, for Barry's services and for the box as a whole.
 *
 * Split from the light tick because one `top` costs ~2.3s against that tick's
 * ~600ms budget — running it every minute would trip this bag's own
 * `sampler-expensive` rule. Hourly would be too coarse in the other direction:
 * a virtualization helper process grew from 292MB to 6GB inside a single hour.
 */
```

## Note 038

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Measure only watched directories and isolate du failures from other collectors.

Original rationale:

```text
/**
 * Disk usage per watched directory.
 *
 * `du -sk` over the instance's data walks gigabytes of files. Run at the sampler's
 * interval that would be the most expensive thing on the box, so this is
 * called on the slow cadence only — see sample()'s `heavy` flag.
 */
```
