// Alert rules describe measured failure conditions and their clearing behavior.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-089

import { METRICS } from "./schema.js";
import { latest, queryPoints, type Db } from "./store.js";

export type RuleKind =
  /** Current value crosses a threshold. */
  | "threshold"
  /** Value grew by more than `delta` across `windowSec`. */
  | "delta"
  /** value / otherMetric exceeds `ratio`. */
  | "ratio"
  /**
   * A series that WAS reporting has gone quiet. The only kind that fires on
   * absence rather than on a value.
   *
   * ## Why this could not be expressed before
   *
   * Every other kind iterates rows that EXIST — `latest()`, filter, loop. A
   * metric that stopped reporting yields an empty set, so the rule produces no
   * evaluation, and `selectNotifications` treats a missing evaluation as
   * RESOLVED. Silence therefore CLEARED an alert instead of raising one. That
   * is correct for the other kinds and is exactly the gap: nothing in this bag
   * could ask "did this stop reporting".
   *
   * Axiom expressed it as a per-monitor `alert_on_no_data`, and the monitor
   * being retired with it — `service_silent`, "alert when core Barry services
   * stop producing logs" — had it set true while `error_spike`, written by the
   * same hand, had it false. Two monitors differing on exactly the axis this
   * kind adds: absence-alerting is deliberately OPT-IN, never a property of
   * every rule. A rule that should stay quiet when its data stops is a normal
   * and correct rule.
   *
   * ## How absence is detected without a registry of what "should" exist
   *
   * `latest()` has no lower time bound, so a series that stopped reporting
   * still returns its final row — the row just gets older. Silence is that
   * row's AGE, which means this needs no separate list of expected identities
   * and cannot go stale against one. A series that never existed at all is
   * invisible here, deliberately: this detects a signal that STOPPED, not one
   * that was never configured, and inventing the latter would fire forever for
   * a service that was intentionally removed.
   *
   * ## The trap
   *
   * `companionHolds` returns false when a `requireMetric` companion has not
   * reported — "firing on a missing corroborating signal is how the false
   * positive got here". That stays true. An absent CORROBORATOR must never
   * fire; an absent SUBJECT is this kind's entire signal. Same `latest()` and
   * the same staleness machinery, opposite meanings, so this kind is gated on
   * `rule.metric` only and leaves `requireMetric` untouched.
   */
  | "no-data";

export interface Rule {
  /** Stable id; the alert-state key, so renaming one re-arms it. */
  id: string;
  kind: RuleKind;
  metric: string;
  /** Human sentence. `{value}`, `{labels}` and `{detail}` are substituted. */
  message: string;
  severity: "warn" | "critical";
  /** threshold/delta: the number to compare against. */
  limit?: number;
  // A separate clear limit adds hysteresis before rearming a threshold alert.
  // Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-090
  clearLimit?: number;
  // Require consecutive breaches to avoid notifying on an isolated spike.
  // Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-091
  forSamples?: number;
  /** threshold: direction. Default "above". */
  direction?: "above" | "below";
  /** delta: lookback window. */
  windowSec?: number;
  /** ratio: denominator metric. */
  denominator?: string;
  // A companion metric must breach for the same label set before notifying.
  // Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-092
  requireMetric?: {
    metric: string;
    /** Fires only if the companion's latest value is over/under this. */
    limit: number;
    direction: "above" | "below";
    /** Why this pairing exists — surfaced like `rationale`. */
    because: string;
  };
  // Limit eligible label sets before evaluation rather than filtering already-fired alerts.
  // Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-093
  labelIn?: Record<string, string[]>;
  // Use configured identity labels for series, staleness and persisted state; other labels remain provenance.
  // Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-094
  identityLabels?: string[];
  // No-data rules require an explicit silence horizon; threshold rules do not use it.
  // Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-095
  silentAfterSec?: number;
  /**
   * For rules firing continuously: minimum seconds between re-notifications.
   * If unset, the alert fires on edge only (never renotifies until resolved and re-fired).
   */
  renotifyAfterSec?: number;
  /** Why this rule exists — shown in the UI so a firing alert explains itself. */
  rationale: string;
}

// Project point labels to the rule’s identity so provenance cannot fork alert state.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-096
export function identityOf(rule: Rule, labels: Record<string, string>): Record<string, string> {
  const keys = rule.identityLabels;
  if (!keys) return labels;
  const out: Record<string, string> = {};
  for (const k of keys) if (labels[k] !== undefined) out[k] = labels[k]!;
  return out;
}

// Keep default rules tied to observable failure modes, with a clearing path.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-097
export const DEFAULT_RULES: Rule[] = [
  {
    id: "service-restart-loop",
    kind: "delta",
    metric: METRICS.serviceRuns.name,
    // Compare the discrete restart count with >= 3, matching the dashboard threshold.
    // See docs/decisions/0043-telemetry-classification-and-alert-cost.md.
    limit: 3,
    windowSec: 3600,
    severity: "critical",
    // Scheduled jobs increment run counts routinely; only resident services qualify for restart alerts.
    // See docs/decisions/0043-telemetry-classification-and-alert-cost.md.
    labelIn: { kind: ["service"] },
    // Require a nonzero previous exit code to distinguish crashes from clean redeploys.
    // See docs/decisions/0043-telemetry-classification-and-alert-cost.md.
    requireMetric: {
      metric: METRICS.serviceLastExit.name,
      limit: 0,
      direction: "above",
      because: "a clean redeploy exits 0; a crash loop does not",
    },
    message: "{labels} restarted {value} times in the last hour",
    rationale:
      "launchd's run counter is monotonic, so the delta is the crash-loop signal. " +
      "A liveness probe finds the service up on both sides of a restart and reports OK; " +
      "the API restarted 11 times in a day while health-check logged 'all checks passed'.",
  },
  {
    id: "error-spike",
    kind: "delta",
    metric: METRICS.errorEvents.name,
    // Apply the hourly error threshold per service, excluding routine warning noise.
    // See docs/decisions/0043-telemetry-classification-and-alert-cost.md.
    limit: 20,
    windowSec: 3600,
    severity: "warn",
    // Errors only. Warnings are advisory by definition and several services
    // emit them steadily; including them would make this fire on healthy
    // noise, which is how an alert channel gets ignored.
    labelIn: { level: ["error"] },
    message: "{labels} logged {value} errors in the last hour",
    rationale:
      "This replaced Axiom's error-spike monitor. The count is cumulative, so the delta is the signal — " +
      "a threshold on the raw total would fire forever once crossed and then never say anything again. " +
      "Delta also catches the shape a threshold misses: a service that goes from 2 errors an hour to 60 " +
      "is broken even though no absolute number looks alarming.",
  },
  {
    id: "port-squatted",
    kind: "threshold",
    metric: METRICS.portOwnedBySupervisor.name,
    limit: 1,
    direction: "below",
    severity: "critical",
    message: "{labels}: the process listening on its port is not the one launchd supervises",
    rationale:
      "An orphaned child that outlived its parent keeps the listener, so every restart " +
      "dies EADDRINUSE while launchd reports success. This is also why a dependent " +
      "sweep can silently stop working: findDeadSessions calls the API, so a squatted " +
      "port disabled the MCP transport reclaim that would have prevented an outage.",
  },
  {
    id: "mcp-transport-leak",
    kind: "ratio",
    metric: METRICS.mcpTransports.name,
    denominator: METRICS.mcpTransportsMax.name,
    limit: 0.6,
    severity: "warn",
    message: "MCP transports at {value} of the ceiling",
    rationale:
      "The leak that reached 1,628 live against a ceiling of 400. A ratio rather than a " +
      "fixed count so retuning MAX_TRANSPORTS cannot silently disarm the alert.",
  },
  {
    id: "health-slow",
    kind: "threshold",
    metric: METRICS.healthMs.name,
    limit: 2000,
    severity: "warn",
    message: "{labels} health check took {value}ms",
    rationale:
      "A spun event loop still ACCEPTS the connection, so a 200 proves nothing on its own. " +
      "Latency is what separates 'serving' from 'wedged at 99% CPU but answering'.",
  },
  {
    id: "service-down",
    kind: "threshold",
    metric: METRICS.healthOk.name,
    // healthOk is 1 or 0, so "below 1" is "the probe failed". Expressed as a
    // threshold rather than a new rule kind because that is all it needs.
    direction: "below",
    limit: 1,
    // ~3 minutes at the 60s tick. A single failed probe is a restart, a GC
    // pause or a laptop waking up; three in a row is the service not serving.
    forSamples: 3,
    severity: "critical",
    message: "{labels} is not answering its health check",
    rationale:
      "barry.health.ok was collected for months and consumed by nothing. On 2026-08-21..23 the " +
      "API failed 40 of 40 probes across three days while web, mcp.server and " +
      "bdiff.review answered in 4-6ms on the same passes — and launchd reported the service up " +
      "the whole time, never restarting it (runs stayed flat at 25). Nothing alerted. " +
      "health-slow could not catch it either: that rule keys on healthMs, and a probe that TIMES " +
      "OUT records the timeout value, so a service which stops answering entirely looks like one " +
      "slow sample rather than an outage. Liveness has to come from the probe, not the supervisor.",
  },
  {
    id: "swap-exhausted",
    kind: "threshold",
    metric: METRICS.hostSwapUsedMb.name,
    // Absolute MB, NOT used/total. macOS grows the swapfile set on demand, so
    // `total` chases `used`: it moved 16384 → 18432 → 16384 → 17408 within four
    // minutes on this box. Both sides of that ratio move, so it flapped across
    // 0.9 constantly — 133 of 315 samples in one 6h window fell back under the
    // limit, re-arming an edge-triggered CRITICAL that sends SMS. The percentage
    // also read as "9% of headroom left" when it really meant "swap is in use
    // and macOS has not grown the file yet". 12 GB is a real number on a 16 GB
    // box: it means most of RAM's worth of pages is on disk.
    limit: 12_288,
    // Must fall a full GB before re-arming, so sitting at the line is one alert.
    clearLimit: 11_264,
    // ~3 minutes at the 60s light tick. Swap spikes during a build and recovers;
    // sustained swap is the pathology worth waking someone for.
    forSamples: 3,
    severity: "critical",
    message: "Host swap in use: {value}MB",
    rationale:
      "Host-level on purpose. Under pressure per-process RSS collapses toward zero because " +
      "processes are paged OUT, so summing RSS to find the culprit points at nothing. " +
      "Absolute rather than a fraction of total because macOS's swap total is itself " +
      "demand-grown: the ratio form flapped over the threshold all day and paged on each crossing.",
  },
  {
    id: "memory-pressure",
    kind: "threshold",
    metric: METRICS.hostMemCompressorPct.name,
    // A third of RAM spent holding compressed pages means the machine is
    // already trading CPU for memory it does not have. Measured at ~28% here
    // while swap was at 16GB, so this crosses BEFORE swap saturates — which is
    // the entire point: swap-exhausted tells you what already happened.
    limit: 33,
    clearLimit: 25,
    forSamples: 5,
    renotifyAfterSec: 86400,
    // warn, not critical: this is the early signal, and the thing it precedes
    // already pages someone. Two SMS for one condition is how escalation dies.
    severity: "warn",
    message: "Memory pressure: compressor holding {value}% of RAM",
    rationale:
      "macOS compresses before it swaps, so compressor occupancy rises first and gives " +
      "warning while there is still time to close something. Swap is the lagging indicator: " +
      "by the time it is large the machine is already paging to disk on every access.",
  },
  {
    id: "disk-dir-large",
    kind: "threshold",
    metric: METRICS.diskDirMb.name,
    limit: 10_240,
    severity: "warn",
    message: "The instance's {labels} directory has grown to {value}MB",
    rationale:
      "Applies to any tracked directory of the instance. Deploy snapshots once sat at 12GB " +
      "under a count cap that considered itself satisfied. Disk is the one resource here that " +
      "never recovers on its own.",
  },
  {
    id: "subprocess-leak",
    kind: "threshold",
    metric: METRICS.childOldestSec.name,
    limit: 4 * 3600,
    severity: "warn",
    labelIn: { kind: ["browser-automation", "mcp-subprocess"] },
    message: "A {labels} subprocess has been alive for {value}s",
    rationale:
      "A headless browser idle for 4h41m was part of ~5GB of leaked subprocesses. Age catches " +
      "this where a count does not. Scoped to spawned subprocesses on purpose: the first live " +
      "run fired on a day-old claude-session and a caffeinate, both of which are entirely " +
      "normal and would have made this alert noise from day one. Resident MCP servers and the " +
      "esbuild compile daemon are classified apart for the same reason — they are supposed to " +
      "outlive any single call, so age says nothing about them.",
  },
  {
    id: "collector-broken",
    kind: "threshold",
    metric: METRICS.collectorOk.name,
    limit: 1,
    direction: "below",
    severity: "warn",
    message: "The metrics collector cannot run {labels}",
    rationale:
      "A collector whose command is missing records nothing, which is indistinguishable from " +
      "a healthy zero. This shipped: launchd's PATH omits /usr/sbin, so sysctl and lsof were " +
      "unreachable and swap plus port-ownership silently went blank while the sampler reported " +
      "success. Blind telemetry is worse than none, because it is trusted.",
  },
  {
    id: "notify-undelivered",
    // DELTA on accumulated failures, NOT a threshold on notifyOk going to 0 and
    // not absence-detection. Two reasons. A single failure is a transient worth
    // retrying, not waking anyone. And the series only gets a row on ticks that
    // actually sent something, so it is legitimately quiet for hours — while
    // `sustained()` counts consecutive SAMPLES and no rule kind here can fire
    // on a metric going silent. Counting failures makes the signal a number
    // that rises, which is the only shape this engine can currently alert on.
    kind: "delta",
    metric: METRICS.notifyFailures.name,
    // 3 in an hour: past a retryable blip, short of paging on one bad send.
    limit: 3,
    windowSec: 3600,
    // warn, not critical — deliberately. Critical escalates to SMS, and SMS is
    // one of the channels this rule reports as broken; paging through the
    // failing path is how the alert becomes indistinguishable from the fault.
    // This is meant to be READ in `status`, where it is visible regardless.
    severity: "warn",
    message: "Alert delivery failing: {value} notifications did not reach a channel in the last hour",
    rationale:
      "The alerting system had no alert on its own delivery. notify() returned a per-send result " +
      "that both call sites discarded, so a measured 121-of-449 (28%) loss was reconstructible " +
      "only by grepping stderr by hand — and it was load-correlated, one send taking 5.2s idle " +
      "against 53.4s at peak on a 30s timeout, so the channel failed precisely when it had " +
      "something to say. barry.collector.ok already asks this question of collection; delivery " +
      "is the other end of the same pipe and was the unwatched one.",
  },
  {
    id: "sampler-expensive",
    kind: "threshold",
    metric: METRICS.samplerMs.name,
    limit: 10_000,
    severity: "warn",
    // Light ticks only. The hourly sweep walks 25GB of ~/.barry with du and
    // measured 16.4s on its first real run — alarming on that would be crying
    // wolf about the bag doing exactly its job.
    labelIn: { mode: ["light"] },
    message: "The metrics sampler's collectors took {value}ms",
    rationale:
      "A monitor that becomes expensive is the failure it exists to catch. The light tick runs " +
      "every minute on a box that has been at 91% swap, so its own cost is a first-class metric. " +
      "Scoped to the light tick: the hourly sweep's du pass is slow by design. This watches " +
      "COLLECTION; sampler-tick-overrun watches the whole job, which is what overruns the interval.",
  },
  {
    // The light tick is scheduled every 60s. A tick that takes longer than its
    // own interval means launchd starts the next one while this is still
    // running — two samplers writing the same reading in the same second, which
    // is where the store's 479 duplicate (labels, ts) pairs came from.
    //
    // 45s rather than 60s so this fires BEFORE the overlap rather than
    // reporting it after: the tick that is about to collide is the one worth
    // knowing about. Well above the ~600ms the README budgets and the 17.2s
    // measured after the latest() fix, so it is not armed to cry wolf.
    // Ported from Axiom's `service_silent` monitor, retired with that vendor:
    // "Alert when core Barry services stop producing logs", operator Below,
    // threshold 1, range 15m, and crucially `alert_on_no_data: true`. Nothing
    // here could express that last part, so the migration dropped it silently
    // and this went unwatched. The original is archived in
    // ~/.claude/plans/axiom-archive/ so its semantics outlive the terraform.
    //
    // Subject is `collectorOk` rather than a service-liveness metric on
    // purpose. `barry.service.up` is written for every discovered launchd
    // label, so it keeps reporting 0 for a service that is down — a VALUE, and
    // `service-down` already alerts on it. What nothing covered is the sampler
    // itself dying: when that happens every metric stops at once, every rule
    // stops evaluating, and `selectNotifications` RESOLVES them all. The
    // monitoring goes quiet and the silence reads as health.
    //
    // 15 minutes against a 60s tick, matching the original's 15:1 ratio. Well
    // clear of the sleep-driven gaps that make `forSamples` rules unreliable
    // overnight, so this does not cry wolf on a closed lid.
    id: "collector-silent",
    kind: "no-data",
    metric: METRICS.collectorOk.name,
    // Identity is the TOOL, not tool+job.
    //
    // The `job` provenance label split every collector into one series per job
    // that runs it: `{tool:"du"}` became `{tool:"du",job:"sample"}` and
    // `{tool:"du",job:"footprint"}`, and `latest()` returns both. Without this
    // narrowing, a collector reporting healthily every 61s via `sample` still
    // fired as silent because its `footprint` variant -- written five times
    // less often -- looked stale on its own.
    //
    // That is the right question restated: "has this collector gone quiet"
    // is about the TOOL. A tool reporting through any job is not silent, and
    // the newest point across jobs is the honest answer. Collapsing here also
    // keeps the rule stable if a collector moves between ticks.
    identityLabels: ["tool"],
    silentAfterSec: 15 * 60,
    severity: "critical",
    message: "{labels}: no metrics recorded for {value} minutes — the sampler may be dead",
    rationale:
      "Every other rule here fires on a VALUE, so all of them go quiet together when the " +
      "sampler stops — and a rule that stops evaluating resolves rather than latches, which " +
      "means a dead monitor presents as a healthy one. This is the only rule that treats " +
      "absence as the signal. Ported from Axiom's service_silent, whose alert_on_no_data flag " +
      "had no local equivalent and was lost in the migration.",
  },
  {
    // A record hook runs another bag's script when an event is created. Its
    // failures are contained ON PURPOSE -- the event is already durable, so a
    // hook must never be able to fail the write -- which means a broken hook
    // changes nothing anyone would notice. This is the number that notices.
    //
    // Delta, not threshold: the metric is cumulative, so a threshold would
    // latch forever after the first failure and then say nothing. One failure
    // is not worth waking someone (a hook can lose a race with a restarting
    // service); a handful in an hour means it is broken rather than unlucky.
    id: "hook-failures",
    kind: "delta",
    metric: METRICS.hookFailures.name,
    limit: 5,
    windowSec: 3600,
    severity: "warn",
    // Identity is the BAG: one bag's broken hook must not mask another's, and
    // the bag name is the only thing that tells you whose script to fix.
    identityLabels: ["bag"],
    message: "{labels}: {value} record-hook failures in the last hour",
    rationale:
      "A hook's failure is swallowed by design so it cannot break the write that triggered it, " +
      "and the hook runs in a spawned process whose exit code nobody else reads. Nothing about " +
      "the system changes when one starts failing, so the count rising is the only evidence " +
      "that exists.",
  },
  {
    // The mirror of the rule above, and the more important one: failures only
    // count if dispatch still HAPPENS. If the seam itself breaks -- the API
    // stops registering the dispatcher, the events bag stops calling it -- the
    // failure count stays flat at whatever it was and reads as healthy.
    //
    // This works only because `hookDispatches` is written on every event even
    // when no bag declares a hook. A metric written only when a hook exists
    // could not tell "the seam is dead" from "nobody subscribes", and would
    // fire the day someone removed their last hook.
    //
    // 6 hours, not 15 minutes like collector-silent: events are driven by human
    // and agent activity rather than a fixed tick, and an idle overnight stretch
    // is normal. This asks "has this stopped working", not "is it busy".
    id: "hook-dispatch-silent",
    kind: "no-data",
    metric: METRICS.hookDispatches.name,
    silentAfterSec: 6 * 3600,
    severity: "warn",
    message: "No record-hook dispatches for {value} minutes — the events hook seam may be dead",
    rationale:
      "Hook failures can only be counted while dispatch still runs. A seam that stopped firing " +
      "produces a flat failure count, which is indistinguishable from a healthy one — the exact " +
      "shape of a check that cannot fail. Absence is the only available signal, which is why " +
      "the dispatch counter is written even when no bag declares a hook.",
  },
  {
    id: "sampler-tick-overrun",
    kind: "threshold",
    metric: METRICS.samplerTickMs.name,
    limit: 45_000,
    // Hysteresis: a tick sitting near the limit under load would otherwise
    // resolve and re-fire every minute, and firing is edge-triggered so each
    // crossing is a fresh notification.
    clearLimit: 30_000,
    severity: "warn",
    labelIn: { mode: ["light"] },
    message: "The metrics tick took {value}ms against a 60s interval",
    rationale:
      "A job slower than its own interval is started again before it finishes, so two samplers " +
      "write the same reading in the same second. That is not hypothetical: sample averaged 26.4s " +
      "and peaked at 441s against 60s, and the store holds 479 duplicate (labels, ts) pairs as a " +
      "result. sampler-expensive could not catch it — barry.sampler.ms brackets collection only, " +
      "and reported 2.3s of that 26.4s.",
  },
  {
    id: "wired-memory-high",
    kind: "threshold",
    metric: METRICS.hostMemWiredPct.name,
    // Measured 48.7% during the investigation against a 25-30% healthy norm, so
    // this fires on the observed pathology rather than sitting above it where it
    // could never be shown to work.
    limit: 42,
    clearLimit: 35,
    forSamples: 5,
    severity: "warn",
    message: "Wired memory at {value}% of RAM",
    rationale:
      "Wired memory can never be paged out or compressed, so it is the floor under every other " +
      "memory reading — 7.2GB of it left only ~8GB for 5.95GB of RSS and forced 48GB into the " +
      "compressor. This is the term that made summed RSS look reassuring while the machine " +
      "swapped itself to a standstill. Warn rather than critical because swap-exhausted already " +
      "pages for the acute case.",
  },
  {
    id: "process-footprint-outsized",
    kind: "threshold",
    metric: METRICS.procFootprintMb.name,
    limit: 4096,
    clearLimit: 3072,
    forSamples: 3,
    // Rank 1 only. Without this the rule evaluates 12 label sets and fires up to
    // 12 separate alerts for one memory event.
    labelIn: { rank: ["1"] },
    // ...and rank ALONE is the identity. Scoping to rank 1 does not by itself
    // give "one series that is always present": `name` is on the point too, so
    // without this the rule gets one series per process name and an alert can
    // latch on a process that has since exited. `name` still renders in the
    // message below — it describes the alert, it does not identify it.
    identityLabels: ["rank"],
    severity: "warn",
    message: "{labels.name} holding {value}MB",
    rationale:
      "The 2026-08-25 investigation concluded 'structural, nothing to fix' because it summed ps " +
      "RSS: 5.95GB across 772 processes against 15GB actually in use. RSS is blind to compressed " +
      "and ballooned pages — a virtualization helper process measured 292MB by RSS and " +
      "4,661-6,137MB in truth, a " +
      "21x understatement. Neither it nor the 4,030MB ollama runner is a Barry service, so a " +
      "metric scoped to Barry would have reported a healthy machine throughout.",
  },
  {
    id: "service-footprint-outsized",
    kind: "threshold",
    metric: METRICS.serviceFootprintMb.name,
    // All Barry services together measured under ~500MB, largest 24h growth
    // +23MB, so this does not fire today. Its falsification test is therefore
    // the important one: without it, "healthy" and "can never fire" look alike.
    limit: 1024,
    clearLimit: 768,
    forSamples: 3,
    labelIn: { kind: ["service"] },
    severity: "warn",
    message: "Service {labels.service} footprint at {value}MB",
    rationale:
      "Gives barry.service.footprint_mb a consumer. The metric was declared in the schema and " +
      "never collected at all, and service-down's rationale already names the matching failure: " +
      "barry.health.ok was collected for months and read by nothing. Measured on real footprint " +
      "rather than RSS, which understates a swapped-out service precisely when it matters.",
  },
  {
    id: "session-fleet-large",
    kind: "threshold",
    metric: METRICS.childProcs.name,
    // 11-14 concurrent sessions is the observed working range on this box and
    // is not itself a problem. 16 is above anything measured, so this reports a
    // fleet that has grown past what was ever deliberately started — usually
    // sessions left open rather than sessions in use.
    limit: 16,
    clearLimit: 12,
    forSamples: 5,
    labelIn: { kind: ["claude-session"] },
    severity: "warn",
    message: "{value} concurrent sessions running",
    rationale:
      "Concurrent sessions are the largest single block of memory on this machine — 12 of them " +
      "measured 5.4GB of real footprint while every Barry service together was under 500MB. This " +
      "NOTIFIES and must never reap: age is disproven as an abandonment signal, because six " +
      "sessions called abandoned at ~4d22h turned out to be three that exited cleanly within the " +
      "hour and three actively burning CPU. Killing one destroys unrecoverable context mid-write " +
      "in a shared tree. A reaper would need a real idle signal from the session store, and even " +
      "then should ask rather than act.",
  },
  {
    id: "session-fleet-memory",
    kind: "threshold",
    metric: METRICS.childRssMb.name,
    // RSS, because that is what childRssMb records — and it UNDERSTATES: the
    // fleet read 981MB here while its real footprint was ~5.4GB, a ~5x gap.
    // 2048 of RSS therefore means roughly 10GB of real memory on a 16GB box.
    limit: 2048,
    clearLimit: 1536,
    forSamples: 5,
    labelIn: { kind: ["claude-session"] },
    severity: "warn",
    message: "Session fleet holding {value}MB (RSS — real footprint is several times this)",
    rationale:
      "Counts alone miss the case that actually hurts: a few sessions with very large contexts. " +
      "Deliberately paired with session-fleet-large rather than replacing it, because either can " +
      "cross without the other. Read the number as a floor, never a total — barry.children.rss_mb " +
      "is RSS, and RSS is blind to the compressed pages that dominate under pressure.",
  },
];

/** An alert that was firing and no longer is. */
export interface ResolvedAlert {
  /** `alert_state` key: rule id + label set. */
  key: string;
  ruleId: string;
  /** The rendered message from when it fired — what the problem actually was. */
  detail: string;
  /** How long it was firing. */
  durationSec: number;
}

export interface RuleEvaluation {
  rule: Rule;
  firing: boolean;
  /** The value that decided it. */
  value: number;
  labels: Record<string, string>;
  /** Rendered message, ready to send. */
  text: string;
}

/** Does this label set pass the rule's `labelIn` filter? */
function matchesLabelFilter(rule: Rule, labels: Record<string, string>): boolean {
  for (const [key, allowed] of Object.entries(rule.labelIn ?? {})) {
    const value = labels[key];
    if (value === undefined || !allowed.includes(value)) return false;
  }
  return true;
}

// Use the same rule-and-label identity for evaluation and persisted firing state.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-098
export function alertKey(ruleId: string, labels: Record<string, string>): string {
  return `${ruleId}|${JSON.stringify(labels)}`;
}

// Look up companion readings for the evaluated series, rather than mixing unrelated labels.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-099
function companionHolds(
  db: Db,
  rule: Rule,
  labels: Record<string, string>,
  now: number,
): boolean {
  const req = rule.requireMetric;
  if (!req) return true;
  const key = JSON.stringify(labels);
  const row = latest(db, req.metric).find((r) => JSON.stringify(r.labels) === key);
  if (!row) return false;
  // latest() returns the newest point for a label set with no upper age bound,
  // so a service that stopped reporting keeps "corroborating" forever. A stale
  // companion must not hold, for the same reason a stale metric must not fire.
  if (isStale(db, req.metric, labels, row.ts, now)) return false;
  return req.direction === "below" ? row.value < req.limit : row.value > req.limit;
}

/** Bound inferred staleness while retaining the fifteen-minute floor; see docs/decisions/0021-telemetry-polling-and-adapter-regressions.md. */
const STALE_FLOOR_SEC = 15 * 60;
const STALE_CEILING_SEC = 6 * 60 * 60;

/** How many recent points to look at when inferring the sampling interval. */
const INTERVAL_SAMPLE_COUNT = 5;

// Reject stale readings before evaluating a current fault.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-100
// Estimate cadence from recent gaps so scheduled collectors tolerate their real interval.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-101
function observedIntervalSec(
  db: Db,
  metric: string,
  labels: Record<string, string>,
  until: number,
): number | undefined {
  const recent = queryPoints(db, { metric, since: 0, until, labels }).slice(-INTERVAL_SAMPLE_COUNT);
  if (recent.length < 2) return undefined;

  let widest = 0;
  for (let i = 1; i < recent.length; i++) {
    widest = Math.max(widest, recent[i].ts - recent[i - 1].ts);
  }
  return widest;
}

function isStale(
  db: Db,
  metric: string,
  labels: Record<string, string>,
  ts: number,
  now: number,
): boolean {
  const age = now - ts;
  // Cheap path: anything inside the floor is fresh under any interval.
  if (age <= STALE_FLOOR_SEC) return false;
  if (age > STALE_CEILING_SEC) return true;

  // Infer the cadence from the series itself. `until: ts` so the window is
  // measured as of the point being judged, not as of now — otherwise a gap
  // AFTER this point (the machine waking up) would widen the tolerance that
  // decides whether this point counts.
  const widest = observedIntervalSec(db, metric, labels, ts);
  if (widest === undefined) return age > STALE_FLOOR_SEC;

  const tolerated = Math.min(Math.max(STALE_FLOOR_SEC, widest * 3), STALE_CEILING_SEC);
  return age > tolerated;
}

/** Is this rule + label set currently in the firing state? */
function isFiring(db: Db, ruleId: string, labels: Record<string, string>): boolean {
  const row = db
    .prepare("SELECT firing FROM alert_state WHERE rule = ?")
    .get(alertKey(ruleId, labels)) as { firing: number } | undefined;
  return row?.firing === 1;
}

// Sustained breaches require eligible recent samples, not any matching points in history.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-102
function sustained(
  db: Db,
  rule: Rule,
  now: number,
  labels: Record<string, string>,
  breaches: (v: number) => boolean,
): boolean {
  const need = rule.forSamples ?? 1;

  // Select consecutive samples by position; each caller applies cadence-aware staleness separately.
  // Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-031
  const points = queryPoints(db, { metric: rule.metric, since: 0, labels });
  const recent = points.slice(-need);
  return recent.length >= need && recent.every((p) => breaches(p.value));
}

function render(rule: Rule, value: number, labels: Record<string, string>): string {
  // `kind` is a filter dimension, not an identity: rendering it would produce
  // "api service restarted 4 times". Identity labels are what name the thing.
  const identity = Object.entries(labels)
    .filter(([k]) => k !== "kind")
    .map(([, v]) => v);
  const labelText = identity.join(" ") || Object.values(labels).join(" ") || "host";
  const shown =
    rule.kind === "ratio" ? `${Math.round(value * 100)}%` : String(Math.round(value * 100) / 100);
  return (
    rule.message
      .replace("{value}", shown)
      // `{labels.name}` names ONE label, where bare `{labels}` joins them all.
      // Rules that rank a top-N (process footprint) need the former: joining
      // every label would render the rank number as part of the process name.
      // A missing key renders as the rule's own label text rather than leaving
      // the braces in the message — an alert that reaches a human with its
      // placeholder unsubstituted is one they cannot act on, which is how this
      // shipped: "{labels.name} holding 6755MB" named nothing.
      .replace(/\{labels\.([A-Za-z0-9_]+)\}/g, (_m, key: string) => labels[key] ?? labelText)
      .replace("{labels}", labelText)
  );
}

// Evaluate per label set and distinguish unavailable evidence from a non-breach.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-103
export function evaluateRule(db: Db, rule: Rule, now = Math.floor(Date.now() / 1000)): RuleEvaluation[] {
  const results: RuleEvaluation[] = [];

  if (rule.kind === "threshold") {
    const below = rule.direction === "below";
    const limit = rule.limit ?? 0;
    const breaches = (v: number): boolean => (below ? v < limit : v > limit);
    // Hysteresis: once firing, the metric must cross `clearLimit` to resolve,
    // which stops a value hovering on the limit from re-notifying.
    //
    // Without an explicit `clearLimit`, clearing is the exact INVERSE of
    // breaching rather than a second strict comparison against `limit`. The
    // strict form left a dead band exactly ON the limit where a value neither
    // breached nor cleared, so an alert already firing could never resolve. For
    // a boolean 0/1 metric that band is the entire healthy state: `service-down`,
    // `port-squatted` and `collector-broken` all use limit 1 with direction
    // "below", so `clears(1)` asked whether `1 > 1` — false — and a recovered
    // service stayed red forever. One `collector-broken` series sat firing for 8
    // days, including 2 days after the underlying fault was fixed.
    const clearLimit = rule.clearLimit;
    const clears =
      clearLimit === undefined
        ? (v: number): boolean => !breaches(v)
        : (v: number): boolean => (below ? v > clearLimit : v < clearLimit);

    // `latest()` returns the newest point per LABEL SET, but a rule's identity
    // may be narrower (see identityLabels). Collapse to the newest point per
    // identity first, or a series that stopped reporting keeps a seat at the
    // table alongside the one that replaced it — which is precisely how this
    // rule latched on an exited process for a week.
    const rows = latest(db, rule.metric);
    const byIdentity = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!matchesLabelFilter(rule, row.labels)) continue;
      const key = JSON.stringify(identityOf(rule, row.labels));
      const held = byIdentity.get(key);
      if (!held || row.ts > held.ts) byIdentity.set(key, row);
    }

    for (const row of byIdentity.values()) {
      const identity = identityOf(rule, row.labels);
      // Stale points must not fire: a service that stopped reporting should
      // surface as missing, not as a frozen last value forever. "Stale" is
      // relative to how often this series actually reports — see isStale.
      if (isStale(db, rule.metric, identity, row.ts, now)) continue;

      const wasFiring = isFiring(db, rule.id, identity);
      // While firing, hold the alert until the metric properly clears; that
      // hold is what stops a value parked on the limit from re-notifying.
      const firing = wasFiring ? !clears(row.value) : breaches(row.value);
      if (!firing) continue;

      // Dwell applies only to the initial fire. Re-checking it while already
      // firing would let one dip below the limit drop an unresolved alert.
      if (!wasFiring && (rule.forSamples ?? 1) > 1) {
        // Identity, not row labels: the dwell window for "whatever is rank 1"
        // spans every process that held the rank, and queryPoints matches
        // labels as a SUBSET, so {rank:"1"} sees them all.
        if (!sustained(db, rule, now, identity, breaches)) continue;
      }

      // `labels` is the IDENTITY, because selectNotifications turns it into the
      // alert_state key and isFiring above read that same key — the two must
      // agree or the alert cannot see its own state. `text` renders from the
      // full row labels so the message still names the process.
      results.push({ rule, firing, value: row.value, labels: identity, text: render(rule, row.value, row.labels) });
    }
    return results;
  }

  if (rule.kind === "no-data") {
    // `silentAfterSec` is REQUIRED. Defaulting it would let a malformed rule
    // evaluate against an arbitrary window and report "not silent" — a rule
    // that cannot fire, which is the failure this kind exists to catch. A
    // throw here is caught by evaluateAll and costs this rule's evaluation
    // only, which is the honest outcome: no answer, rather than a wrong one.
    if (!rule.silentAfterSec) {
      throw new Error(`no-data rule ${rule.id} has no silentAfterSec`);
    }

    // The subject's own rows. A series that stopped still returns its last
    // point, so silence is that point's age — see the kind's docstring for why
    // this needs no registry of expected identities.
    const rows = latest(db, rule.metric);

    // Collapse to one row per identity first, exactly as `threshold` does: a
    // series replaced by another must not keep a seat beside its replacement.
    const byIdentity = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!matchesLabelFilter(rule, row.labels)) continue;
      const key = JSON.stringify(identityOf(rule, row.labels));
      const held = byIdentity.get(key);
      if (!held || row.ts > held.ts) byIdentity.set(key, row);
    }

    for (const row of byIdentity.values()) {
      const identity = identityOf(rule, row.labels);
      const ageSec = now - row.ts;

      // `silentAfterSec` is a FLOOR, widened by how often this series actually
      // reports. A flat threshold treats every series as if it ticked at the
      // same rate, and they do not: `collectorOk{tool:"ps"}` is written every
      // 61s by `sample`, while `{tool:"ollama"}` and `{tool:"top-parse"}` are
      // written every 299s by `footprint` -- five times sparser.
      //
      // Against one 15-minute bound the sparse ones sit three ticks from the
      // edge where the fast ones sit fifteen, so any hiccup trips them first.
      // That shipped: both fired during a four-minute maintenance gap while
      // only 3.1 minutes stale, which is a rule crying wolf about a collector
      // doing exactly what it was scheduled to do.
      //
      // `isStale` already solved this for the other kinds -- three observed
      // intervals tolerates a slow tick without tolerating a dead one -- so
      // this reuses the same inference rather than inventing a second notion
      // of "how late is late".
      //
      // A series with too few points to infer a cadence falls back to the
      // declared floor. That is "cannot tell" resolving to the strictest
      // honest answer, not to silence.
      const observed = observedIntervalSec(db, rule.metric, row.labels, row.ts);
      const threshold = Math.max(
        rule.silentAfterSec,
        observed === undefined ? 0 : observed * 3,
      );
      if (ageSec < threshold) continue;

      // A companion still gates this kind, and still must not fire on its own
      // absence — that asymmetry is the point. Absent SUBJECT is the signal;
      // absent CORROBORATOR is not.
      if (!companionHolds(db, rule, row.labels, now)) continue;

      results.push({
        rule,
        firing: true,
        labels: identity,
        // Minutes, not seconds: the message says "silent for {value}m", and an
        // operator reading an alert at 3am should not be dividing by 60.
        value: Math.round(ageSec / 60),
        text: render(rule, Math.round(ageSec / 60), identity),
      });
    }

    return results;
  }

  if (rule.kind === "delta") {
    const window = rule.windowSec ?? 3600;
    const points = queryPoints(db, { metric: rule.metric, since: now - window });
    // Group by label set, then compare each series' last value to its first.
    const series = new Map<string, { first: number; last: number; lastTs: number; labels: Record<string, string> }>();
    for (const p of points) {
      const key = JSON.stringify(p.labels);
      const existing = series.get(key);
      if (!existing) series.set(key, { first: p.value, last: p.value, lastTs: p.ts, labels: p.labels });
      else {
        existing.last = p.value;
        existing.lastTs = p.ts;
      }
    }
    for (const s of series.values()) {
      if (!matchesLabelFilter(rule, s.labels)) continue;
      // Same staleness guard the threshold branch has always had. Without it a
      // DELETED service keeps firing: its points stay inside the lookback
      // window for a full hour, and the requireMetric companion reads latest(),
      // which never expires at all — so the alert latched permanently. Removing
      // a crash-looping service left its own crash-loop alert stuck on.
      if (isStale(db, rule.metric, s.labels, s.lastTs, now)) continue;
      const growth = s.last - s.first;
      // Inclusive: see the note on service-restart-loop's limit.
      if (growth < (rule.limit ?? 0)) continue;
      if (!companionHolds(db, rule, s.labels, now)) continue;
      results.push({ rule, firing: true, value: growth, labels: s.labels, text: render(rule, growth, s.labels) });
    }
    return results;
  }

  const nums = latest(db, rule.metric);
  const dens = latest(db, rule.denominator ?? "");
  for (const num of nums) {
    // Match on label set so a per-service ratio compares like with like.
    const den = dens.find((d) => JSON.stringify(d.labels) === JSON.stringify(num.labels)) ?? dens[0];
    if (!den || den.value === 0) continue;
    if (isStale(db, rule.metric, num.labels, num.ts, now)) continue;
    const ratio = num.value / den.value;
    if (ratio > (rule.limit ?? 0)) {
      results.push({ rule, firing: true, value: ratio, labels: num.labels, text: render(rule, ratio, num.labels) });
    }
  }
  return results;
}

/** Evaluate every rule. */
export function evaluateAll(db: Db, rules = DEFAULT_RULES, now = Math.floor(Date.now() / 1000)): RuleEvaluation[] {
  const out: RuleEvaluation[] = [];
  for (const rule of rules) {
    try {
      out.push(...evaluateRule(db, rule, now));
    } catch {
      // A malformed rule costs its own evaluation, never the whole pass.
    }
  }
  return out;
}

// Persist firing and recovery state before selecting notifications so repeated ticks do not resend.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-104
export function selectNotifications(
  db: Db,
  evaluations: RuleEvaluation[],
  now = Math.floor(Date.now() / 1000),
): { fired: RuleEvaluation[]; resolved: ResolvedAlert[] } {
  const firingKeys = new Set<string>();
  const fired: RuleEvaluation[] = [];

  const upsert = db.prepare(
    `INSERT INTO alert_state (rule, firing, since, last_seen, detail, last_notified) VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(rule) DO UPDATE SET firing = 1, last_seen = excluded.last_seen, detail = excluded.detail,
       last_notified = COALESCE(excluded.last_notified, alert_state.last_notified)`,
  );

  for (const ev of evaluations) {
    // Key on rule + labels so two services breaching the same rule are two
    // independent alerts rather than one that flaps between them.
    const key = alertKey(ev.rule.id, ev.labels);
    firingKeys.add(key);

    const prev = db.prepare("SELECT firing, since, last_notified FROM alert_state WHERE rule = ?").get(key) as
      | { firing: number; since: number; last_notified: number | null }
      | undefined;

    if (!prev || prev.firing === 0) {
      upsert.run(key, now, now, ev.text, now);
      fired.push(ev);
    } else {
      const lastNotified = prev.last_notified ?? prev.since;
      if (ev.rule.renotifyAfterSec !== undefined && now - lastNotified >= ev.rule.renotifyAfterSec) {
        upsert.run(key, prev.since, now, ev.text, now);
        fired.push(ev);
      } else {
        upsert.run(key, prev.since, now, ev.text, null);
      }
    }
  }

  // Anything previously firing that no longer evaluates has recovered.
  const previouslyFiring = db
    .prepare("SELECT rule, since, detail FROM alert_state WHERE firing = 1")
    .all() as Array<{ rule: string; since: number; detail: string }>;

  const resolved: ResolvedAlert[] = [];
  for (const row of previouslyFiring) {
    if (firingKeys.has(row.rule)) continue;
    db.prepare("UPDATE alert_state SET firing = 0, last_seen = ? WHERE rule = ?").run(now, row.rule);
    // `detail` is the rendered message from when it fired, which says what the
    // problem was in words. The key alone ("swap-exhausted|{}") is not something
    // anyone should have to read in Slack at 3am.
    resolved.push({
      key: row.rule,
      ruleId: row.rule.split("|")[0] ?? row.rule,
      detail: row.detail,
      durationSec: Math.max(0, now - row.since),
    });
  }

  return { fired, resolved };
}
