# ADR 0008: Telemetry regression contracts

## Context

Shorter source narratives also mixed regression rationale and historical observations. These notes preserve the complete comment-pass context for the tests and contracts being condensed.

## Decision

Keep the controlling invariant in source and the supporting explanation here. No executable behavior changes.

## Consequences

Future changes must preserve the linked negative controls, unavailable states, parameterization and idempotency. Historical observations are evidence, not current measurements.

## Note 001

Source: [bags/telemetry/src/alert-state-migration.test.ts](../../bags/telemetry/src/alert-state-migration.test.ts)

The migration accepts both legacy shapes, including stores where the old per-tick ALTER already ran.

Original rationale:

```text
/**
 * alert_state.last_notified used to be added by an ALTER TABLE attempted on
 * every sampler tick, its failure swallowed. It is a migration now, and it has
 * to land on both shapes a 001 store can have: with the column (the old ALTER
 * ran) and without it (a store that never evaluated a rule).
 */
```

## Note 002

Source: [bags/telemetry/src/collect-bookkeeping.test.ts](../../bags/telemetry/src/collect-bookkeeping.test.ts)

Quiet bookkeeping output omits the model group because no model call occurred.

Original rationale:

```text
/**
 * Also verbatim — and the MAJORITY case: 38 of the last 60 ticks wrote nothing.
 * Note there is no `model(...)` group at all, because no calls were made.
 */
```

## Note 003

Source: [bags/telemetry/src/collect-bookkeeping.test.ts](../../bags/telemetry/src/collect-bookkeeping.test.ts)

A quiet run has absent latency rather than a zero measurement or parse failure.

Original rationale:

```text
/**
   * The common case. A quiet run has no `model(...)` group, so latency is
   * genuinely absent — not zero, and emphatically not a parse failure. Reading
   * it as one would report a broken parser on most healthy runs.
   */
```

## Note 004

Source: [bags/telemetry/src/collect-bookkeeping.test.ts](../../bags/telemetry/src/collect-bookkeeping.test.ts)

Unrecognized summary formats return null so collector health exposes upstream drift.

Original rationale:

```text
/**
   * THE point of this collector. If the upstream format moves, every counter
   * would otherwise read 0 — indistinguishable from a job that ran and found
   * nothing to do. These must parse as null so parse_ok goes to 0.
   */
```

## Note 005

Source: [bags/telemetry/src/collect-bookkeeping.test.ts](../../bags/telemetry/src/collect-bookkeeping.test.ts)

Do not invent zero latency for a quiet run that made no model call.

Original rationale:

```text
/**
   * A p50 of 0s would be a measurement, and a quiet run made none. Zeroing it
   * would drag the average down and invent a latency improvement that never
   * happened.
   */
```

## Note 006

Source: [bags/telemetry/src/collect-bookkeeping.test.ts](../../bags/telemetry/src/collect-bookkeeping.test.ts)

A missing action store means unavailable history rather than a changed summary format.

Original rationale:

```text
/**
   * A missing actions.db means nothing has run here, which is not the job's
   * format changing. Reporting parse_ok=0 would raise an alert about a missing file.
   */
```

## Note 007

Source: [bags/telemetry/src/collect-hooks.ts](../../bags/telemetry/src/collect-hooks.ts)

Health success and failure share tool identity so no-data rules follow one continuous series.

Original rationale:

```text
/**
   * The healthy point, and the ONLY one that carries the bare `{tool:"hooks"}`
   * identity. `collector-silent` narrows to `identityLabels: ["tool"]`, so it
   * reads this and the failures below as one series either way.
   */
```

## Note 008

Source: [bags/telemetry/src/collect-ollama.test.ts](../../bags/telemetry/src/collect-ollama.test.ts)

Emit collector health so idle Ollama and stopped Ollama remain distinguishable.

Original rationale:

```text
/**
   * THE test. A quit Ollama and an idle Ollama both have zero models loaded, so
   * `loaded_mb = 0` alone means both "nothing to do" and "not running". Without
   * collectorOk these two states are the same picture — the defect this bag
   * exists to catch, in the collector added to catch it.
   */
```

## Note 009

Source: [bags/telemetry/src/collect-ollama.test.ts](../../bags/telemetry/src/collect-ollama.test.ts)

Emit continuous totals after model unload so an alert can satisfy its clearing threshold.

Original rationale:

```text
/**
   * The total must be CONTINUOUS. A per-model series stops emitting when its
   * model unloads, and a series that goes silent instead of reporting a low
   * value cannot satisfy an alert's clearLimit — that is how the process
   * footprint alert stayed firing on an exited process for over a week.
   */
```

## Note 010

Source: [bags/telemetry/src/collect-ollama.test.ts](../../bags/telemetry/src/collect-ollama.test.ts)

Partial daemon failure must not prevent unrelated collectors from recording their results.

Original rationale:

```text
/**
   * /api/ps answering while /api/tags does not is odd enough that guessing
   * would be worse than recording nothing — but the rest of the tick must
   * still land.
   */
```

## Note 011

Source: [bags/telemetry/src/collect.test.ts](../../bags/telemetry/src/collect.test.ts)

Captured command output protects parsers against assumptions about real platform formats.

Original rationale:

```text
/**
 * Fixtures are captured from this machine, not invented. A parser tested only
 * against output the author imagined is a parser tested against the author's
 * assumptions.
 */
```

## Note 012

Source: [bags/telemetry/src/collect.test.ts](../../bags/telemetry/src/collect.test.ts)

Resident MCP servers are not one-job subprocesses; age alone cannot classify them as leaks.

Original rationale:

```text
/**
   * A resident MCP server is not a leak candidate. `uvx temporal-mcp-server`
   * reached 103h and fired subprocess-leak every time the MCP host had been up
   * that long — a true reading of the wrong thing. Age only means something for
   * a subprocess spawned to do ONE job.
   */
```

## Note 013

Source: [bags/telemetry/src/collect.test.ts](../../bags/telemetry/src/collect.test.ts)

Supervisor conflict state is direct evidence of a foreign listener on the configured port.

Original rationale:

```text
/**
   * The supervisor reports a foreign listener directly as state "conflict".
   * This is the primary signal for a squatted port.
   */
```

## Note 014

Source: [bags/telemetry/src/collect.test.ts](../../bags/telemetry/src/collect.test.ts)

Keep sampler mode labels stable; these once-per-tick series do not need collector-job provenance.

Original rationale:

```text
/**
   * samplerMs and samplerPoints keep `mode` and must NOT gain `job`.
   * `sampler-expensive` scopes itself with `labelIn: { mode: ["light"] }`, and
   * these are written once per tick by definition, so they cannot collide with
   * themselves. Re-keying them would break that filter for no gain.
   */
```

## Note 015

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Discover supervised services so newly installed services need no hardcoded collector entry.

Original rationale:

```text
/**
 * A supervised Barry service to sample.
 *
 * Services are DISCOVERED from the supervisor rather than hardcoded. A newly
 * installed bag service is watched without editing this file.
 */
```

## Note 016

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

The elapsed ceiling rejects sleep artifacts while allowing legitimately expensive heavy ticks.

Original rationale:

```text
/**
 * Ceiling for a sampler tick. The heavy tick's `du` pass legitimately takes tens
 * of seconds (16.4s measured on its first real run), so this is deliberately
 * generous — it exists to reject sleep artifacts, not to police slowness.
 */
```

## Note 017

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Read one process table per tick to avoid hundreds of expensive per-PID calls.

Original rationale:

```text
/**
 * Parse `ps -Ao pid,ppid,rss,%cpu,etime,command`.
 *
 * One `ps` for the whole tree rather than a call per PID: at ~600 processes
 * the per-process version costs seconds, which this budget cannot afford.
 */
```

## Note 018

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

ps CPU percent is a lifetime average; cumulative CPU differences provide interval utilization.

Original rationale:

```text
/**
   * `ps` %CPU — a LIFETIME average since exec, not an instantaneous reading.
   * Kept because it is what ps reports; see cpuSec for the usable signal.
   */
```

## Note 019

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Do not prune repository-adjacent session worktrees through the instance-directory budget.

Original rationale:

```text
/**
 * The instance's directories worth a size budget, by the label they report
 * under. Session worktrees are not among them: they live beside your
 * repositories as your code, and the sessions bag's disk-retention job prunes
 * the ones sessions recorded.
 */
```

## Note 020

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Check required binaries explicitly so missing tools produce visible collector failures.

Original rationale:

```text
/**
 * Verify every tool a collector needs is present and executable.
 *
 * Cheap (one stat per binary) and worth it: this is the check that turns a
 * silent PATH problem into a visible metric.
 */
```

## Note 021

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Run directory walks on the slower heavy schedule because they dominate collector cost.

Original rationale:

```text
/**
   * Include the expensive collectors (directory walks). Passed on a slower
   * schedule than the base tick, because `du` over ~/.barry costs orders of
   * magnitude more than every other collector combined.
   */
```

## Note 022

Source: [bags/telemetry/src/collect.ts](../../bags/telemetry/src/collect.ts)

Footprint sampling has its own cadence between the minute tick and hourly sweep.

Original rationale:

```text
/**
   * Include the process-footprint collector. Separate from `heavy` because it
   * runs on its own cadence: ~2.3s is too expensive for the 60s tick and too
   * valuable to defer to the hourly sweep.
   */
```

## Note 023

Source: [bags/telemetry/src/framework/contributed-panels.test.ts](../../bags/telemetry/src/framework/contributed-panels.test.ts)

Validate contributed IDs because DOM IDs and path segments cannot safely contain arbitrary markup.

Original rationale:

```text
/**
   * The id becomes a DOM id and a URL path segment, so it is validated rather
   * than escaped — there is no correct way to escape markup into an id.
   */
```

## Note 024

Source: [bags/telemetry/src/framework/contributed-panels.test.ts](../../bags/telemetry/src/framework/contributed-panels.test.ts)

Contributors name paths on their own origin; reject scheme-relative paths that escape it.

Original rationale:

```text
/**
   * The contributor says WHAT path on its own service, never WHICH host. A
   * scheme-relative path would make `new URL(p, base)` leave the base's origin
   * entirely, turning the host's fetch into a request forgery the contributor
   * controls.
   */
```

## Note 025

Source: [bags/telemetry/src/framework/contributed-panels.test.ts](../../bags/telemetry/src/framework/contributed-panels.test.ts)

Contributor failures return unavailable rather than falsely claiming an empty measured panel.

Original rationale:

```text
/**
   * THE requirement. Every one of these is a real way a separate process
   * fails, and not one of them may come back as `empty` — an empty panel reads
   * as "nothing happened", which for a dead contributor is a confident lie.
   */
```

## Note 026

Source: [bags/telemetry/src/framework/contributed-panels.test.ts](../../bags/telemetry/src/framework/contributed-panels.test.ts)

Escape contributor titles as text so contributions cannot inject elements.

Original rationale:

```text
/**
   * A title is untrusted input. The contributor supplies text and only text —
   * the reason the descriptor was chosen over a contributed page is that there
   * is no path here by which it emits an element.
   */
```

## Note 027

Source: [bags/telemetry/src/framework/contributed-panels.test.ts](../../bags/telemetry/src/framework/contributed-panels.test.ts)

With no contributions, page bytes remain identical to the original host document.

Original rationale:

```text
/**
   * The inertness guarantee: with nothing contributed, every page is the exact
   * bytes it was before this mechanism existed.
   */
```

## Note 028

Source: [bags/telemetry/src/framework/contributed-panels.ts](../../bags/telemetry/src/framework/contributed-panels.ts)

Restrict stable panel IDs to a safe alphabet for DOM and URL use.

Original rationale:

```text
/**
   * Stable id, namespaced by bag at registration. Used as the DOM id and the
   * API path segment, so it is restricted to a safe alphabet rather than
   * escaped — an id is not display text and has no business containing markup.
   */
```

## Note 029

Source: [bags/telemetry/src/framework/contributed-panels.ts](../../bags/telemetry/src/framework/contributed-panels.ts)

Validate identifiers and escape display text; those are different trust boundaries.

Original rationale:

```text
/**
 * Ids and bag names reach a DOM id and a URL path, so they are validated
 * rather than escaped. Titles and cells are display text and are escaped.
 */
```

## Note 030

Source: [bags/telemetry/src/framework/contributions.test.ts](../../bags/telemetry/src/framework/contributions.test.ts)

An absent contribution file must not stop the dashboard needed to diagnose the absence.

Original rationale:

```text
/**
   * A dashboard that cannot start because a file is absent is a dashboard that
   * cannot be used to diagnose why things are absent.
   */
```

## Note 031

Source: [bags/telemetry/src/framework/contributions.test.ts](../../bags/telemetry/src/framework/contributions.test.ts)

One malformed contribution fails only its owner, preserving other bags’ panels.

Original rationale:

```text
/**
   * `registry.ts`'s rule — a contributor that fails costs only itself —
   * applied at registration. One bag's bad declaration must not cost every
   * other bag its panels.
   */
```

## Note 032

Source: [bags/telemetry/src/framework/correlate.test.ts](../../bags/telemetry/src/framework/correlate.test.ts)

Correlations must not include rows from a different session.

Original rationale:

```text
/**
   * Another session's rows must not leak in. The whole value of a trace is that
   * it is ONE session — a join that over-matches turns an investigation into
   * noise, and noise during an incident is worse than nothing.
   */
```

## Note 033

Source: [bags/telemetry/src/framework/correlate.test.ts](../../bags/telemetry/src/framework/correlate.test.ts)

Unreadable evidence is unavailable rather than a successful report of no errors.

Original rationale:

```text
/**
   * "No errors" and "the store is unreadable" must not render the same way.
   * This is the distinction the bag gets wrong most often.
   */
```

## Note 034

Source: [bags/telemetry/src/framework/correlate.test.ts](../../bags/telemetry/src/framework/correlate.test.ts)

Without a recorded session window, time-only request correlation cannot attribute unrelated traffic.

Original rationale:

```text
/**
   * Requests have no session column, so they can only be bounded by time — and
   * without usage rows there is no honest window. Guessing a span would present
   * unrelated traffic as this session's.
   */
```

## Note 035

Source: [bags/telemetry/src/framework/correlate.test.ts](../../bags/telemetry/src/framework/correlate.test.ts)

Mark capped correlation results as partial so a sample does not look complete.

Original rationale:

```text
/**
   * A capped result must say so. Sessions run for days — one real window spanned
   * 4.5 days with 1,343 usage rows — so N rows out of it is a sample, and
   * rendering a sample as the whole is a confident wrong answer.
   */
```

## Note 036

Source: [bags/telemetry/src/framework/pages.test.ts](../../bags/telemetry/src/framework/pages.test.ts)

Page files and central registration must agree in both directions.

Original rationale:

```text
/**
   * Every page in the list must exist on disk, and every page on disk must be
   * in the list. A file present but unlisted is unreachable — the route loop
   * only serves what PAGES names — and that would look exactly like a broken
   * link rather than a missing registration.
   */
```

## Note 037

Source: [bags/telemetry/src/framework/pages.test.ts](../../bags/telemetry/src/framework/pages.test.ts)

Generated navigation replaces every marker; retained literal navigation would silently drift.

Original rationale:

```text
/**
   * The nav used to be copied into all nine pages by hand, and had already
   * drifted: index.html's copy differed from the other eight. A literal <nav>
   * left in any page would silently win over the generated one.
   */
```

## Note 038

Source: [bags/telemetry/src/framework/pages.test.ts](../../bags/telemetry/src/framework/pages.test.ts)

Infrastructure deliberately has no empty time-window control because it has no windowed view.

Original rationale:

```text
/**
   * The time-window control is driven by $("windows") in catalog.js and
   * jobs.js. Infrastructure has no windowed view, so an empty div there would
   * be markup for a control nothing populates — the asymmetry is deliberate
   * and is asserted so a later "tidy-up" has to argue with it.
   */
```

## Note 039

Source: [bags/telemetry/src/framework/pages.ts](../../bags/telemetry/src/framework/pages.ts)

Keep incident infrastructure first in navigation and metric discovery last.

Original rationale:

```text
/**
 * Order is the nav order, and it is deliberate: Infrastructure first because it
 * is what you open during an incident, Metrics last because it is the catalog
 * you reach for when you already know what you are looking for.
 */
```

## Note 040

Source: [bags/telemetry/src/framework/pages.ts](../../bags/telemetry/src/framework/pages.ts)

Mark the active link with aria-current for both styling and screen readers.

Original rationale:

```text
/**
 * The `<nav>` for one page.
 *
 * `aria-current="page"` marks the active link — it is what the stylesheet keys
 * on, and what tells a screen reader which of nine links you are on.
 */
```

## Note 041

Source: [bags/telemetry/src/framework/pages.ts](../../bags/telemetry/src/framework/pages.ts)

A page without the navigation marker remains usable instead of failing over a missing comment.

Original rationale:

```text
/**
 * Substitute the generated nav into a page's HTML.
 *
 * A page without the marker is returned unchanged rather than rejected: an
 * error here would take down a working dashboard over a missing comment.
 */
```

## Note 042

Source: [bags/telemetry/src/framework/registry.test.ts](../../bags/telemetry/src/framework/registry.test.ts)

Reject duplicate metric ownership at registration rather than emitting ambiguous data.

Original rationale:

```text
/**
   * The Prometheus rule: a duplicate found while collecting is confusing data
   * at 3am; the same duplicate found at registration is a startup error naming
   * both claimants.
   */
```

## Note 043

Source: [bags/telemetry/src/framework/registry.test.ts](../../bags/telemetry/src/framework/registry.test.ts)

Require rule rationale at registration so unexplained alerts cannot become silently muted monitoring.

Original rationale:

```text
/**
   * A rule that cannot explain itself gets muted, and a muted rule is a
   * monitoring outage that looks like quiet. Refused at registration rather
   * than discovered when it fires.
   */
```

## Note 044

Source: [bags/telemetry/src/framework/registry.test.ts](../../bags/telemetry/src/framework/registry.test.ts)

Isolate contributed collector failures and attribute each failure to its owning bag.

Original rationale:

```text
/**
   * `sample()` runs collectors under allSettled so one failure costs its own
   * metrics and nothing else. Contributed collectors get the same isolation,
   * and the failing bag is named — an unattributable bad collector is how the
   * MCP transport leak stayed anonymous.
   */
```

## Note 045

Source: [bags/telemetry/src/framework/registry.test.ts](../../bags/telemetry/src/framework/registry.test.ts)

A contribution must register its metric, rule and collector without editing host code.

Original rationale:

```text
/**
   * The acceptance test for the whole framework: a bag contributes a metric, a
   * rule and a collector, and every one lands — with no edit to this repo.
   */
```

## Note 046

Source: [bags/telemetry/src/framework/registry.ts](../../bags/telemetry/src/framework/registry.ts)

Every rule requires rationale so operators can assess a firing instead of muting unexplained noise.

Original rationale:

```text
/**
   * Alert rules. Each still needs a `rationale` — a rule that cannot explain
   * itself gets muted, and a muted rule is a monitoring outage that looks quiet.
   */
```

## Note 047

Source: [bags/telemetry/src/framework/registry.ts](../../bags/telemetry/src/framework/registry.ts)

Contributed collectors must emit health even when their measured dependency fails.

Original rationale:

```text
/**
   * Pulled on the bag's own cadence. Must resolve even when the thing it
   * measures is broken: returning no points reads as healthy, which is the
   * failure this bag exists to catch. Emit a `collectorOk` point either way.
   */
```

## Note 048

Source: [bags/telemetry/src/framework/registry.ts](../../bags/telemetry/src/framework/registry.ts)

Seed built-in descriptors so contributions cannot shadow their metric names.

Original rationale:

```text
/**
   * Seed the built-in descriptors so contributed names collide with them too.
   *
   * Without this a contributor could shadow `barry.service.up` and the conflict
   * would only appear as two series fighting over one name.
   */
```

## Note 095

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Clamp model reports to the attribution start so unobserved history is not charted as zero usage.

Original rationale:

```text
/**
   * model_id was only populated from 2026-08-19. Without the clamp a 90-day
   * window renders two months of zeroes that read as "no model was used" rather
   * than "this was never recorded" — a false statement, drawn confidently.
   */
```

## Note 096

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Bucket code comes from a closed enum; the time window is the only SQL parameter.

Original rationale:

```text
/**
   * The bucket format is interpolated code from a closed enum, and the window
   * is the ONLY bound parameter. A bound bucket would put its `?` in the
   * SELECT ahead of the window's and swap the values (found live, 2026-09-22:
   * the panel rendered empty because `created_at >= 'day'` matches nothing).
   */
```

## Note 097

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Clamp overnight gaps so a paused session cannot dominate a tool’s inferred latency percentile.

Original rationale:

```text
/**
   * One session paused overnight contributes a ~40,000s gap. Unclipped it owns
   * the p95 for whatever tool happened to be last before the pause.
   */
```

## Note 098

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Preserve rank-based p95 in SQLite; replacing it with max would mislabel the statistic.

Original rationale:

```text
/**
   * percentile_cont does not exist in SQLite. The rank-and-pick form must
   * survive the port intact: a transcript to `max(gap_s)` would silently
   * degrade p95 to worst-case, which is the one number the clip exists to
   * tame — and the panel is labelled with p95, so the label would start lying.
   */
```

## Note 099

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Convert ISO timestamps through julianday before computing elapsed seconds.

Original rationale:

```text
/**
   * ISO text subtracts as strings; only julianday yields seconds. A query that
   * subtracts the text directly would produce NaN-rank garbage rather than an
   * error.
   */
```

## Note 100

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Keep sessions with no identity so grouped totals agree with other reports.

Original rationale:

```text
/**
   * Sessions with no identity are a real slice of the data. Dropping them would
   * make this panel's total quietly disagree with every other panel. The merge
   * itself lives in the read model; this query must carry the raw id through,
   * NULLs included.
   */
```

## Note 101

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

A partial single-file ROI query cannot stand in for the absent cross-store report.

Original rationale:

```text
/**
   * The zero rows ARE the ROI panel — but that panel needs a cross-file join
   * the seam decision stopped before, so it is absent from this file. Its
   * absence is the honest state; re-adding it as a single-file query would
   * credit only the bags that were called and look complete while doing it.
   */
```

## Note 102

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Escape underscores in MCP-name LIKE filters so ordinary tool names do not match as MCP.

Original rationale:

```text
/**
   * Tool names are `mcp__<server>__<tool>`, and an unescaped `_` is a
   * single-character wildcard: without ESCAPE the filter matches tool names
   * that are not MCP at all. SQLite does not escape `_` by default.
   */
```

## Note 103

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Stuck runs remain reportable even when their start falls outside the requested recent window.

Original rationale:

```text
/**
   * A run stuck open for two weeks falls outside a 7-day window exactly as it
   * becomes most worth reporting — the longer it is stuck, the more invisible a
   * windowed query makes it. The live data has one open since 345 hours ago,
   * which no 7-day or 30-day window would show.
   */
```

## Note 104

Source: [bags/telemetry/src/usage/queries.test.ts](../../bags/telemetry/src/usage/queries.test.ts)

Use the stored complete status; a plausible completed spelling would misclassify finished runs.

Original rationale:

```text
/**
   * 'complete' is the value action_runs actually uses; 'completed' is the
   * plausible-looking one. Matching only the second would report every finished
   * run as stuck — a panel screaming about healthy work.
   */
```

## Note 105

Source: [bags/telemetry/src/usage/queries.ts](../../bags/telemetry/src/usage/queries.ts)

Fold worktrees through the registered repo_of function before grouping repository usage.

Original rationale:

```text
/**
 * Where the work happens, keyed by repo rather than raw path.
 *
 * Worktree folding is `repo_of`, a registered function — see stores.ts for why
 * the regex moved out of the SQL.
 */
```

## Note 106

Source: [bags/telemetry/src/usage/report-cache.test.ts](../../bags/telemetry/src/usage/report-cache.test.ts)

Control promise resolution explicitly to prove concurrent callers share one in-flight build.

Original rationale:

```text
/**
 * A promise plus its own resolve, so a test can hold a `build()` call open
 * until it has proven two callers are ALREADY both waiting on it — not just
 * probably overlapping because they were fired back to back.
 */
```

## Note 107

Source: [bags/telemetry/src/usage/report-cache.test.ts](../../bags/telemetry/src/usage/report-cache.test.ts)

Report cache age so a reused result differs visibly from a fresh build.

Original rationale:

```text
/**
   * Negative control for the staleness field: without it, two calls inside
   * the TTL would be indistinguishable to a caller — this proves the second,
   * cache-served call actually carries a nonzero age once time has passed.
   */
```

## Note 108

Source: [bags/telemetry/src/usage/report-cache.ts](../../bags/telemetry/src/usage/report-cache.ts)

Return staleness with the cached value rather than requiring a second freshness request.

Original rationale:

```text
/**
 * A cached report value, plus how stale it is.
 *
 * `staleMs` lets a client tell "this just loaded" from "this is the same
 * response as 25 seconds ago" without a separate freshness endpoint.
 */
```

## Note 109

Source: [bags/telemetry/src/usage/requests.test.ts](../../bags/telemetry/src/usage/requests.test.ts)

Normalize legacy raw request IDs at ingest so one handler does not fragment into many routes.

Original rationale:

```text
/**
   * History written before the logger fix still carries raw session ids, so
   * templating is applied again at ingest. Without it one handler appears as
   * hundreds of routes and no aggregation means anything.
   */
```

## Note 110

Source: [bags/telemetry/src/usage/requests.test.ts](../../bags/telemetry/src/usage/requests.test.ts)

Invalid saved offsets reset to zero rather than crashing or seeking outside meaningful input.

Original rationale:

```text
/**
   * Negative control: a corrupt stored offset (negative, non-integer, or NaN)
   * must reset to 0 exactly like a rotation, never crash and never seek to a
   * nonsense position. The review explicitly calls this out as required
   * coverage alongside the truncation happy path.
   */
```

## Note 111

Source: [bags/telemetry/src/usage/requests.test.ts](../../bags/telemetry/src/usage/requests.test.ts)

An offset beyond current EOF indicates rotation and requires replay from zero.

Original rationale:

```text
/**
   * The truncation fixture the review calls for: a stored offset far past the
   * file's actual current size (simulating a rotation that happened between
   * ingest passes). Ingestion must detect this and re-read from 0 rather than
   * seeking past EOF and silently reading nothing forever after.
   */
```

## Note 112

Source: [bags/telemetry/src/usage/requests.test.ts](../../bags/telemetry/src/usage/requests.test.ts)

Do not advance the saved offset through a partial trailing record.

Original rationale:

```text
/**
   * A partial line at the tail (the writer mid-write, no trailing newline
   * yet) must not be counted into the stored offset — otherwise the next pass
   * starts reading AFTER it and the rest of that record, once written, is
   * never seen. This is what `lastByteIsNewline` guards inside ingestLog.
   */
```

## Note 113

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Coalesce window-keyed Tool Intelligence reads so multiple polling tabs share one rebuild.

Original rationale:

```text
/**
 * 30s cache, keyed by window: the Tool Intelligence page polls every 60s and
 * can have more than one tab open, and its queries walk the message table —
 * worth sharing one rebuild rather than paying it per tab per poll.
 */
```

## Note 114

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Coalesce window-keyed Reliability reads so repeated polling does not duplicate the widest report.

Original rationale:

```text
/**
 * 30s cache, keyed by window. The Reliability page polls every 60s and reads
 * the same panels every time; this is the widest report here and the
 * one this bag's own outage history makes most worth not rebuilding twice for
 * two tabs open at once.
 */
```

## Note 115

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Cache the busiest usage page by its window so multiple tabs reuse one bounded rebuild.

Original rationale:

```text
/**
 * 30s cache, keyed by window. This is the busiest page in the dashboard (the
 * default landing view for usage) and the most likely to have two tabs
 * polling it at once.
 */
```

## Note 116

Source: [bags/telemetry/src/usage/summary-usage.ts](../../bags/telemetry/src/usage/summary-usage.ts)

Mark pre-attribution model windows as partial even though SQL already clamps their values.

Original rationale:

```text
/**
 * Mark the model panel as partial when the window predates attribution.
 *
 * The SQL already clamps the range, so the numbers are right either way. This
 * exists so the READER knows the chart starts later than they asked for.
 */
```

## Note 117

Source: [bags/telemetry/src/usage/telemetry.test.ts](../../bags/telemetry/src/usage/telemetry.test.ts)

Result IDs provide retry idempotency; different resumed-session results remain distinct rows.

Original rationale:

```text
/**
   * A session can emit several `result` events (resume, continuation). Each is
   * its own row keyed by its own id — summing them is the caller's job. Replaying
   * the SAME id must not double-count, which is what makes a retry safe.
   */
```

## Note 118

Source: [bags/telemetry/src/usage/telemetry.test.ts](../../bags/telemetry/src/usage/telemetry.test.ts)

Unknown error flags remain NULL rather than becoming inferred success from result text.

Original rationale:

```text
/**
   * is_error comes from the SDK rather than from parsing result text. Text
   * matching found 7 errors in 17,500 Bash calls, which is obviously wrong — so
   * the column must distinguish "no error" from "not known", and NULL is what
   * carries that.
   */
```

## Note 119

Source: [bags/telemetry/src/usage/telemetry.test.ts](../../bags/telemetry/src/usage/telemetry.test.ts)

Before any usage row exists, report not measuring yet rather than a fabricated zero-cost history.

Original rationale:

```text
/**
   * Cost panels clamp their window to this. Before any row exists there is no
   * floor, and the panel must say "not measuring yet" rather than charting zero
   * — a zero cost is a claim, and it would be false.
   */
```

## Note 120

Source: [bags/telemetry/src/usage/telemetry.test.ts](../../bags/telemetry/src/usage/telemetry.test.ts)

Reprice stored tokens so cost recovery still works after the vendor prunes a transcript.

Original rationale:

```text
/**
   * A row whose transcript the vendor has already pruned can never be re-read,
   * so adding a model's price does not reach it — the ingest skips that session
   * entirely. Repricing from the stored tokens is the only way back, and without
   * it $853 of real spend stayed invisible behind "not priced".
   */
```

## Note 121

Source: [bags/telemetry/src/usage/telemetry.test.ts](../../bags/telemetry/src/usage/telemetry.test.ts)

An unpriced cost is NULL, never a free-call measurement.

Original rationale:

```text
/**
     * The whole point of the NULL is that it means "not costed", never "free".
     * Writing a zero here would convert an honest gap into a false measurement —
     * exactly the failure the NULL was introduced to prevent.
     */
```

## Note 122

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

Vendor request IDs deduplicate turns appearing in multiple resumed-session transcripts.

Original rationale:

```text
/**
   * requestId is the vendor's own idempotency key, and it is what makes
   * re-ingesting the same transcript a no-op. A resumed session's turns appear
   * in more than one file; without a stable key they would double-count.
   */
```

## Note 123

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

Unpriced models return no cost rather than falsely claiming their calls were free.

Original rationale:

```text
/**
   * An unpriced model must yield NO cost, never zero. Zero says the calls were
   * free; undefined says they were not costed. The dashboard renders the second
   * as "not priced" — a $0.00 next to a real figure is indistinguishable from a
   * measurement.
   */
```

## Note 124

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

Keep literal model-specific pricing so a generic family mapping cannot silently halve spend.

Original rationale:

```text
/**
   * Fable 5 is not priced like the Opus family it sits beside — 2x on input and
   * output, and a cache read of 1.0 rather than the 0.1x multiplier every other
   * model here follows. Pinned as a literal so a future "tidy up" that maps it
   * onto an Opus row fails loudly instead of halving the reported spend.
   */
```

## Note 125

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

Use the longest known model prefix so build-date suffixes retain the correct pricing family.

Original rationale:

```text
/**
   * Vendor model ids carry a build-date suffix. Matching the longest known
   * prefix keeps a new build of a priced model costed instead of silently
   * dropping into the uncosted bucket.
   */
```

## Note 126

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

A result needs its parent invocation to recover a tool name; unpaired results cannot create rows.

Original rationale:

```text
/**
   * The tool NAME lives only on the parent's `tool_use` block — the result
   * record does not repeat it. An unpaired result therefore has no name and
   * cannot become a row; dropping it is what keeps the store from growing a
   * bucket of anonymous durations.
   */
```

## Note 127

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

Pair parallel results by invocation ID rather than by their order.

Original rationale:

```text
/**
   * One assistant turn can issue several tool calls at once, and their results
   * arrive as separate records all naming the same parent. Pairing is by
   * `tool_use_id`, not by position, or parallel calls would be mislabelled with
   * each other's names.
   */
```

## Note 128

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

An absent outcome remains unknown instead of increasing measured success coverage.

Original rationale:

```text
/**
   * Absent must stay undefined, never false. `errorCoverage()` counts a non-null
   * flag as "known", so defaulting to false would claim 9,886 calls were
   * observed to succeed when their outcome was never recorded.
   */
```

## Note 129

Source: [bags/telemetry/src/usage/transcripts.test.ts](../../bags/telemetry/src/usage/transcripts.test.ts)

Stable invocation IDs make repeated transcript ingestion idempotent.

Original rationale:

```text
/**
   * The id is what makes re-ingest a no-op, exactly as `requestId` does for
   * cost. Two reads of the same transcript must yield the same key or the
   * hourly job would multiply every row it has already written.
   */
```

## Note 130

Source: [bags/telemetry/src/usage/transcripts.ts](../../bags/telemetry/src/usage/transcripts.ts)

Whole-file transcript access supports matching results to earlier parent records.

Original rationale:

```text
/**
 * Every tool call in a transcript, with the wall time it took.
 *
 * Reads the file whole rather than streaming it like `readTranscript`, because
 * pairing needs random access to a parent that may appear anywhere earlier.
 */
```

## Note 131

Source: [bags/telemetry/tools.ts](../../bags/telemetry/tools.ts)

Clamp requested usage windows so an oversized request means all retained history rather than failure.

Original rationale:

```text
/**
 * Window parameter, shared by every usage-backed tool.
 *
 * Clamped rather than rejected, for the same reason the dashboard clamps it: a
 * caller who asks for 10,000 days wants "everything", not an error.
 */
```

## Note 132

Source: [bags/telemetry/tools.ts](../../bags/telemetry/tools.ts)

Usage tools read their owning local store without requiring a remote database URL.

Original rationale:

```text
/**
 * Token spend and measured tool durations.
 *
 * Reads the bag-owned usage.db, so unlike the remote-backed tools below it
 * works with no database URL configured.
 */
```

## Note 133

Source: [bags/telemetry/tools.ts](../../bags/telemetry/tools.ts)

Read request history from the local store before supervisor log rotation loses the source.

Original rationale:

```text
/**
 * HTTP request volume, route latency and error mix.
 *
 * Reads the bag-owned requests store, which the ingest job fills from service
 * logs before the supervisor rotates them away.
 */
```

## Note 134

Source: [bags/telemetry/web/schedules.js](../../bags/telemetry/web/schedules.js)

Render schedule values with textContent so they cannot become markup.

Original rationale:

```text
/**
 * Schedules — is the scheduler alive, and is each schedule doing its job.
 *
 * Values reach the DOM through textContent, which cannot interpret markup.
 */
```

## Note 135

Source: [bags/telemetry/web/spark.test.js](../../bags/telemetry/web/spark.test.js)

Stop polling a backgrounded tab so hidden dashboards do not keep loading the server.

Original rationale:

```text
/**
   * The defect this whole piece exists to fix: a backgrounded tab kept
   * polling at full cadence. Without the visibility check this test would see
   * a third call at t=2000 exactly like a foregrounded tab.
   */
```
