// Share read models between dashboard and MCP tools so both report the same evidence.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-149

import { METRICS } from "./schema.js";
import { latest, queryPoints, queryRollups, type Db } from "./store.js";
import { evaluateAll, DEFAULT_RULES, type Rule, alertKey } from "./rules.js";
import { registry } from "./framework/telemetry.js";
import { formatDuration } from "./sampler.js";

export interface ServiceSummary {
  name: string;
  // Distinguish resident services from periodic jobs when interpreting liveness.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-150
  kind?: "service" | "job";
  // Current process liveness does not describe whether a periodic job ran successfully.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-151
  up: boolean;
  runs?: number;
  // Interpret launchd starts within the selected window, accounting for reload resets.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-152
  runsLastHour?: number;
  // A counter decrease marks a reset, not negative activity.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-153
  runsCounterReset?: boolean;
  rssMb?: number;
  cpuPct?: number;
  healthOk?: boolean;
  healthMs?: number;
  portListening?: boolean;
  portOwned?: boolean;
}

function byService(rows: ReturnType<typeof latest>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const name = r.labels.service;
    if (name) out.set(name, r.value);
  }
  return out;
}

/**
 * The `kind` label the collector puts on every service metric.
 *
 * Separate from `byService` because that keeps only the value, which is what
 * lost this distinction in the first place.
 */
function kindByService(rows: ReturnType<typeof latest>): Map<string, "service" | "job"> {
  const out = new Map<string, "service" | "job">();
  for (const r of rows) {
    const name = r.labels.service;
    const kind = r.labels.kind;
    if (name && (kind === "service" || kind === "job")) out.set(name, kind);
  }
  return out;
}

/** Current state of every watched service. */
export function serviceSummaries(db: Db, now = Math.floor(Date.now() / 1000)): ServiceSummary[] {
  const upRows = latest(db, METRICS.serviceUp.name);
  const up = byService(upRows);
  const kind = kindByService(upRows);
  const runs = byService(latest(db, METRICS.serviceRuns.name));
  const rss = byService(latest(db, METRICS.serviceRssMb.name));
  const cpu = byService(latest(db, METRICS.serviceCpuPct.name));
  const healthOk = byService(latest(db, METRICS.healthOk.name));
  const healthMs = byService(latest(db, METRICS.healthMs.name));
  const listening = byService(latest(db, METRICS.portListening.name));
  const owned = byService(latest(db, METRICS.portOwnedBySupervisor.name));

  // Restart delta over the last hour, per service.
  const hourAgo = now - 3600;
  const runsHistory = queryPoints(db, { metric: METRICS.serviceRuns.name, since: hourAgo });
  const firstRuns = new Map<string, number>();
  const lastRuns = new Map<string, number>();
  for (const p of runsHistory) {
    const name = p.labels.service;
    if (!name) continue;
    if (!firstRuns.has(name)) firstRuns.set(name, p.value);
    lastRuns.set(name, p.value);
  }

  const names = new Set([...up.keys(), ...runs.keys()]);
  return [...names]
    .sort()
    .map((name) => {
      const first = firstRuns.get(name);
      const last = lastRuns.get(name);
      const haveWindow = first !== undefined && last !== undefined;
      // A reload resets launchd's counter, so `last - first` can be negative. Report
      // the reset rather than the meaningless subtraction: a negative run count
      // reads as healthy, and a wrong number is worse than an absent one.
      const reset = haveWindow && last < first;
      return {
        name,
        kind: kind.get(name),
        up: up.get(name) === 1,
        runs: runs.get(name),
        runsLastHour: haveWindow && !reset ? last - first : undefined,
        runsCounterReset: reset || undefined,
        rssMb: rss.get(name),
        cpuPct: cpu.get(name),
        healthOk: healthOk.has(name) ? healthOk.get(name) === 1 : undefined,
        healthMs: healthMs.get(name),
        portListening: listening.has(name) ? listening.get(name) === 1 : undefined,
        portOwned: owned.has(name) ? owned.get(name) === 1 : undefined,
      };
    });
}

export interface HostSummary {
  swapUsedMb?: number;
  swapTotalMb?: number;
  swapPct?: number;
  load1?: number;
  diskMb: Array<{ dir: string; mb: number }>;
  children: Array<{ kind: string; count: number; rssMb: number; oldestSec: number }>;
  mcpTransports?: number;
  mcpTransportsMax?: number;
  samplerMs?: number;
  lastSampleTs?: number;
}

function scalar(db: Db, metric: string): { value: number; ts: number } | undefined {
  const rows = latest(db, metric);
  return rows[0] ? { value: rows[0].value, ts: rows[0].ts } : undefined;
}

export function hostSummary(db: Db): HostSummary {
  const swapUsed = scalar(db, METRICS.hostSwapUsedMb.name);
  const swapTotal = scalar(db, METRICS.hostSwapTotalMb.name);
  // Specifically the light tick: it is the every-60s cost and the one worth
  // showing. Taking whichever row came first would flip between 0.5s and 16s
  // depending on when the hourly sweep last ran.
  const samplerRows = latest(db, METRICS.samplerMs.name);
  const sampler =
    samplerRows.find((r) => r.labels.mode === "light") ?? samplerRows[0];

  const counts = latest(db, METRICS.childProcs.name);
  const rss = new Map(latest(db, METRICS.childRssMb.name).map((r) => [r.labels.kind, r.value]));
  const oldest = new Map(latest(db, METRICS.childOldestSec.name).map((r) => [r.labels.kind, r.value]));

  return {
    swapUsedMb: swapUsed?.value,
    swapTotalMb: swapTotal?.value,
    swapPct:
      swapUsed && swapTotal && swapTotal.value > 0
        ? swapUsed.value / swapTotal.value
        : undefined,
    load1: scalar(db, METRICS.hostLoad1.name)?.value,
    diskMb: latest(db, METRICS.diskDirMb.name)
      .map((r) => ({ dir: r.labels.dir ?? "?", mb: r.value }))
      .sort((a, b) => b.mb - a.mb),
    children: counts
      .map((r) => ({
        kind: r.labels.kind ?? "?",
        count: r.value,
        rssMb: rss.get(r.labels.kind) ?? 0,
        oldestSec: oldest.get(r.labels.kind) ?? 0,
      }))
      .sort((a, b) => b.rssMb - a.rssMb),
    mcpTransports: scalar(db, METRICS.mcpTransports.name)?.value,
    mcpTransportsMax: scalar(db, METRICS.mcpTransportsMax.name)?.value,
    samplerMs: sampler?.value,
    lastSampleTs: sampler?.ts,
  };
}

export interface AlertSummary {
  id: string;
  severity: Rule["severity"];
  /** Live: rendered from the measurement that fired this alert. */
  text: string;
  // Keep static rule rationale separate from the current readings that caused a firing.
  // Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-154
  whyThisRuleExists: string;
  since: string;
  duration: string;
}

/** Rules firing right now. */
export function firingAlerts(db: Db, now = Math.floor(Date.now() / 1000)): AlertSummary[] {
  // Shipped rules plus contributed ones, so the dashboard's firing list and
  // the sampler's notification pass see the same rule set -- a rule that
  // alerted but never appeared as firing would be a contradiction a reader
  // cannot resolve.
  let sinceStmt: ReturnType<Db["prepare"]> | undefined;
  try {
    sinceStmt = db.prepare("SELECT since FROM alert_state WHERE rule = ? AND firing = 1");
  } catch {
    // alert_state table may not exist yet
  }

  return evaluateAll(db, [...DEFAULT_RULES, ...registry.rules()], now).map((ev) => {
    const key = alertKey(ev.rule.id, ev.labels);
    let sinceSec = now;
    if (sinceStmt) {
      try {
        const row = sinceStmt.get(key) as { since: number } | undefined;
        if (row && typeof row.since === "number") {
          sinceSec = row.since;
        }
      } catch {
        // Fall back to now
      }
    }
    const elapsedSec = Math.max(0, now - sinceSec);
    return {
      id: ev.rule.id,
      severity: ev.rule.severity,
      text: ev.text,
      whyThisRuleExists: ev.rule.rationale,
      since: new Date(sinceSec * 1000).toISOString(),
      duration: formatDuration(elapsedSec),
    };
  });
}

// Merge raw and rollup history so a downsampled chart spans the requested window.
// Rationale: docs/decisions/0005-telemetry-storage-and-metric-invariants.md#note-155
export function series(
  db: Db,
  metric: string,
  sinceSec: number,
  labels?: Record<string, string>,
  points = 240,
): Array<{ ts: number; value: number }> {
  const now = Math.floor(Date.now() / 1000);
  const since = now - sinceSec;
  // Rollups first: they are strictly older than every raw point, so the
  // concatenation is already sorted.
  const rolled = queryRollups(db, { metric, since, labels });
  const raw = queryPoints(db, { metric, since, labels, limit: 100_000 });
  const all = rolled.concat(raw);
  if (all.length <= points) return all.map((r) => ({ ts: r.ts, value: r.value }));

  const bucketSec = Math.ceil(sinceSec / points);
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const r of all) {
    const b = Math.floor(r.ts / bucketSec) * bucketSec;
    const acc = buckets.get(b) ?? { sum: 0, n: 0 };
    acc.sum += r.value;
    acc.n += 1;
    buckets.set(b, acc);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, acc]) => ({ ts, value: acc.sum / acc.n }));
}
