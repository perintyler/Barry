// Share usage read models between dashboard and MCP tools to preserve result semantics.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-192

import { elapsedMs } from "../collect.js";
import {
  openStores, closeStores, toolIndexPresent, toolIndexMissingWarning,
  type Stores, type StoreHandle, type StorePartition,
} from "./stores.js";
import Database from "better-sqlite3";
// The result type is framework-level: "source is down" vs "no activity" is not
// a database concern. Re-exported so existing importers are unaffected.
import type { Panel } from "../framework/panel.js";
export type { Panel };
import type { Query } from "./queries.js";
import * as Q from "./queries.js";
import {
  openUsageDb, costByDay, costByModel, toolDurations, errorCoverage, measuringSince,
} from "./telemetry.js";
import { ReportCache } from "./report-cache.js";

// Reported query duration is clamped for rendering; this does not cancel SQLite execution.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-193
const PANEL_CEILING_MS = 5_000;


/** One result row. Panels render whatever columns their query selected. */
export type Row = Record<string, string>;

function partitionHasRequiredTable(db: Database.Database, queryText: string): boolean {
  try {
    if (queryText.includes("FROM messages") || queryText.includes("JOIN messages")) {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
      if (!has) return false;
    }
    if (queryText.includes("FROM sessions") || queryText.includes("JOIN sessions")) {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
      if (!has) return false;
    }
    if (queryText.includes("FROM action_runs")) {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'action_runs'").get();
      if (!has) return false;
    }
    if (queryText.includes("FROM events")) {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
      if (!has) return false;
    }
    if (queryText.includes("FROM identities")) {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'identities'").get();
      if (!has) return false;
    }
    return true;
  } catch {
    return true;
  }
}

function adaptPartitionQuery(query: Query): Query {
  if (query.text.includes("FROM action_runs") && query.text.includes("completed_at IS NULL") && query.text.includes("HAVING")) {
    return { text: query.text, params: [0] };
  }
  if (query.text.includes("LIMIT ?")) {
    return {
      text: query.text.replace(/LIMIT \?/g, ""),
      params: query.params.slice(0, -1),
    };
  }
  return query;
}

function runTurnGaps(partitions: StorePartition[], query: Query): Row[] {
  const mem = new Database(":memory:");
  try {
    mem.exec("CREATE TABLE gaps (name TEXT, gap_s REAL)");
    const insert = mem.prepare("INSERT INTO gaps (name, gap_s) VALUES (?, ?)");
    const insertBatch = mem.transaction((rows: { name: string; gap_s: number }[]) => {
      for (const r of rows) insert.run(r.name, r.gap_s);
    });
    for (const p of partitions) {
      const hasTable = p.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
      if (!hasTable) continue;
      const rows = p.db.prepare(`
        SELECT name,
               (julianday(lead(created_at) OVER (PARTITION BY session_id ORDER BY sequence))
                - julianday(created_at)) * 86400 AS gap_s
        FROM messages
        WHERE created_at >= ?
      `).all(query.params[0]) as { name: string; gap_s: number }[];
      insertBatch(rows);
    }
    const excluded = Q.GAP_EXCLUDED_TOOLS.map(() => "?").join(", ");
    const finalSql = `
      WITH ranked AS (
        SELECT name, gap_s,
               row_number() OVER (PARTITION BY name ORDER BY gap_s) AS rn,
               count(*)     OVER (PARTITION BY name)                AS n
        FROM gaps
        WHERE name IS NOT NULL AND gap_s BETWEEN 0 AND 900 AND name NOT IN (${excluded})
      )
      SELECT name AS tool,
             n AS samples,
             round(max(CASE WHEN rn = CAST(ceil(0.5  * n) AS INTEGER) THEN gap_s END), 1) AS p50,
             round(max(CASE WHEN rn = CAST(ceil(0.95 * n) AS INTEGER) THEN gap_s END), 1) AS p95
      FROM ranked
      GROUP BY name, n
      HAVING n >= ?
      ORDER BY p95 DESC
      LIMIT 25`;
    return mem.prepare(finalSql).all(...query.params.slice(1)) as Row[];
  } finally {
    mem.close();
  }
}

function mergePartitionRows(query: string, allRows: Record<string, unknown>[], params: unknown[]): Record<string, unknown>[] {
  // The matches below are written on one line; the SQL in queries.ts is not.
  const queryText = query.replace(/\s+/g, " ");
  if (queryText.includes("FROM action_runs") && allRows.some((r) => "total_s" in r || "runs" in r)) {
    const groups = new Map<string, { bag: string; action: string; status: string; runs: number; total_s: number; timed: number; last_run: string | null }>();
    for (const r of allRows) {
      const key = `${r.bag}\0${r.action}\0${r.status}`;
      const existing = groups.get(key);
      const runs = Number(r.runs ?? 0);
      const total_s = Number(r.total_s ?? 0);
      const timed = Number(r.timed ?? 0);
      const last_run = r.last_run ? String(r.last_run) : null;
      if (!existing) {
        groups.set(key, { bag: String(r.bag), action: String(r.action), status: String(r.status), runs, total_s, timed, last_run });
      } else {
        existing.runs += runs;
        existing.total_s += total_s;
        existing.timed += timed;
        if (last_run && (!existing.last_run || last_run > existing.last_run)) {
          existing.last_run = last_run;
        }
      }
    }
    return Array.from(groups.values())
      .map((g) => ({
        bag: g.bag,
        action: g.action,
        status: g.status,
        runs: String(g.runs),
        // As SQL's avg() did: over the runs that have a duration, null when none do.
        avg_s: g.timed > 0 ? String(Math.round((g.total_s / g.timed) * 10) / 10) : null,
        last_run: g.last_run,
      }))
      .sort((a, b) => Number(b.runs) - Number(a.runs));
  }

  if (queryText.includes("FROM action_runs") && allRows.some((r) => "open" in r && "oldest_hours" in r)) {
    const minHours = Number(params[0] ?? 1);
    const groups = new Map<string, { bag: string; action: string; status: string; open: number; oldest_hours: number }>();
    for (const r of allRows) {
      const key = `${r.bag}\0${r.action}\0${r.status}`;
      const existing = groups.get(key);
      const open = Number(r.open ?? 0);
      const oldest_hours = Number(r.oldest_hours ?? 0);
      if (!existing) {
        groups.set(key, { bag: String(r.bag), action: String(r.action), status: String(r.status), open, oldest_hours });
      } else {
        existing.open += open;
        existing.oldest_hours = Math.max(existing.oldest_hours, oldest_hours);
      }
    }
    return Array.from(groups.values())
      .filter((g) => g.oldest_hours >= minHours)
      .map((g) => ({
        bag: g.bag,
        action: g.action,
        status: g.status,
        open: String(g.open),
        oldest_hours: String(g.oldest_hours),
      }))
      .sort((a, b) => Number(b.oldest_hours) - Number(a.oldest_hours));
  }

  if (queryText.includes("FROM events")) {
    const groups = new Map<string, { type: string; severity: string; source: string; events: number; latest: string | null }>();
    for (const r of allRows) {
      const key = `${r.type}\0${r.severity}\0${r.source}`;
      const existing = groups.get(key);
      const events = Number(r.events ?? 0);
      const latest = r.latest ? String(r.latest) : null;
      if (!existing) {
        groups.set(key, { type: String(r.type), severity: String(r.severity), source: String(r.source), events, latest });
      } else {
        existing.events += events;
        if (latest && (!existing.latest || latest > existing.latest)) {
          existing.latest = latest;
        }
      }
    }
    return Array.from(groups.values())
      .map((g) => ({
        type: g.type,
        severity: g.severity,
        source: g.source,
        events: String(g.events),
        latest: g.latest,
      }))
      .sort((a, b) => Number(b.events) - Number(a.events));
  }

  if (queryText.includes("strftime(") && queryText.includes("AS bucket")) {
    const groups = new Map<string, { bucket: string; tool_calls: number; assistant: number; user_msgs: number; sessions: number }>();
    for (const r of allRows) {
      const key = String(r.bucket);
      const existing = groups.get(key);
      const tool_calls = Number(r.tool_calls ?? 0);
      const assistant = Number(r.assistant ?? 0);
      const user_msgs = Number(r.user_msgs ?? 0);
      const sessions = Number(r.sessions ?? 0);
      if (!existing) {
        groups.set(key, { bucket: key, tool_calls, assistant, user_msgs, sessions });
      } else {
        existing.tool_calls += tool_calls;
        existing.assistant += assistant;
        existing.user_msgs += user_msgs;
        existing.sessions += sessions;
      }
    }
    return Array.from(groups.values())
      .map((g) => ({
        bucket: g.bucket,
        tool_calls: String(g.tool_calls),
        assistant: String(g.assistant),
        user_msgs: String(g.user_msgs),
        sessions: String(g.sessions),
      }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));
  }

  if (queryText.includes("AS source") && queryText.includes("FROM sessions")) {
    const groups = new Map<string, { source: string; sessions: number; last_seen: string | null }>();
    for (const r of allRows) {
      const key = String(r.source);
      const existing = groups.get(key);
      const sessions = Number(r.sessions ?? 0);
      const last_seen = r.last_seen ? String(r.last_seen) : null;
      if (!existing) {
        groups.set(key, { source: key, sessions, last_seen });
      } else {
        existing.sessions += sessions;
        if (last_seen && (!existing.last_seen || last_seen > existing.last_seen)) {
          existing.last_seen = last_seen;
        }
      }
    }
    return Array.from(groups.values())
      .map((g) => ({
        source: g.source,
        sessions: String(g.sessions),
        last_seen: g.last_seen,
      }))
      .sort((a, b) => Number(b.sessions) - Number(a.sessions));
  }

  if (queryText.includes("AS repo") && queryText.includes("FROM sessions")) {
    const limit = Number(params[params.length - 1] ?? 15);
    const groups = new Map<string, { repo: string; sessions: number; tool_calls: number }>();
    for (const r of allRows) {
      const key = String(r.repo);
      const existing = groups.get(key);
      const sessions = Number(r.sessions ?? 0);
      const tool_calls = Number(r.tool_calls ?? 0);
      if (!existing) {
        groups.set(key, { repo: key, sessions, tool_calls });
      } else {
        existing.sessions += sessions;
        existing.tool_calls += tool_calls;
      }
    }
    return Array.from(groups.values())
      .map((g) => ({
        repo: g.repo,
        sessions: String(g.sessions),
        tool_calls: String(g.tool_calls),
      }))
      .sort((a, b) => {
        const diffCalls = Number(b.tool_calls) - Number(a.tool_calls);
        if (diffCalls !== 0) return diffCalls;
        return Number(b.sessions) - Number(a.sessions);
      })
      .slice(0, limit);
  }

  if (queryText.includes("SELECT status, count(*) AS sessions FROM sessions")) {
    const groups = new Map<string, { status: string; sessions: number }>();
    for (const r of allRows) {
      const key = String(r.status);
      const existing = groups.get(key);
      const sessions = Number(r.sessions ?? 0);
      if (!existing) {
        groups.set(key, { status: key, sessions });
      } else {
        existing.sessions += sessions;
      }
    }
    return Array.from(groups.values())
      .map((g) => ({
        status: g.status,
        sessions: String(g.sessions),
      }))
      .sort((a, b) => Number(b.sessions) - Number(a.sessions));
  }

  if (queryText.includes("AS model") && queryText.includes("FROM messages")) {
    const groups = new Map<string, { model: string; messages: number }>();
    for (const r of allRows) {
      const key = String(r.model);
      const existing = groups.get(key);
      const messages = Number(r.messages ?? 0);
      if (!existing) {
        groups.set(key, { model: key, messages });
      } else {
        existing.messages += messages;
      }
    }
    return Array.from(groups.values())
      .map((g) => ({
        model: g.model,
        messages: String(g.messages),
      }))
      .sort((a, b) => Number(b.messages) - Number(a.messages));
  }

  if (queryText.includes("SELECT identity_id, count(*) AS sessions FROM sessions")) {
    const groups = new Map<string | null, { identity_id: unknown; sessions: number }>();
    for (const r of allRows) {
      const key = r.identity_id === null ? null : String(r.identity_id);
      const existing = groups.get(key);
      const sessions = Number(r.sessions ?? 0);
      if (!existing) {
        groups.set(key, { identity_id: r.identity_id, sessions });
      } else {
        existing.sessions += sessions;
      }
    }
    return Array.from(groups.values()).map((g) => ({
      identity_id: g.identity_id,
      sessions: g.sessions,
    }));
  }

  if (queryText.includes("SELECT name AS tool") && queryText.includes("FROM messages")) {
    const limit = Number(params[params.length - 1] ?? 30);
    const groups = new Map<string, { tool: string; calls: number; sessions: number }>();
    for (const r of allRows) {
      const key = String(r.tool);
      const existing = groups.get(key);
      const calls = Number(r.calls ?? 0);
      const sessions = Number(r.sessions ?? 0);
      if (!existing) {
        groups.set(key, { tool: key, calls, sessions });
      } else {
        existing.calls += calls;
        existing.sessions += sessions;
      }
    }
    return Array.from(groups.values())
      .map((g) => ({
        tool: g.tool,
        calls: String(g.calls),
        sessions: String(g.sessions),
      }))
      .sort((a, b) => Number(b.calls) - Number(a.calls))
      .slice(0, limit);
  }

  if (queryText.includes("AS bag") && queryText.includes("FROM messages")) {
    const groups = new Map<string, { bag: string; calls: number; sessions: number; last_used: string | null }>();
    for (const r of allRows) {
      const key = String(r.bag);
      const existing = groups.get(key);
      const calls = Number(r.calls ?? 0);
      const sessions = Number(r.sessions ?? 0);
      const last_used = r.last_used ? String(r.last_used) : null;
      if (!existing) {
        groups.set(key, { bag: key, calls, sessions, last_used });
      } else {
        existing.calls += calls;
        existing.sessions += sessions;
        if (last_used && (!existing.last_used || last_used > existing.last_used)) {
          existing.last_used = last_used;
        }
      }
    }
    return Array.from(groups.values())
      .map((g) => ({
        bag: g.bag,
        calls: String(g.calls),
        sessions: String(g.sessions),
        last_used: g.last_used,
      }))
      .sort((a, b) => Number(b.calls) - Number(a.calls));
  }

  if (queryText.includes("SELECT id, name FROM identities")) {
    const seen = new Set<string>();
    const res: Record<string, unknown>[] = [];
    for (const r of allRows) {
      const key = String(r.id);
      if (!seen.has(key)) {
        seen.add(key);
        res.push(r);
      }
    }
    return res;
  }

  return allRows;
}

// Classify query failures explicitly so an unavailable panel differs from a measured empty result.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-194
export async function runPanel<T>(
  store: StoreHandle,
  query: Query,
  emptyExplanation: string,
): Promise<Panel<T[]>> {
  if (store.problem) {
    return { state: "unavailable", reason: store.problem };
  }
  if (!store.db && (!store.partitions || store.partitions.length === 0)) {
    return { state: "unavailable", reason: `${store.name} store is unavailable` };
  }
  // Monotonic, for the reason elapsedMs documents: `Date.now()` is wall clock,
  // and a laptop closed mid-query would report the sleep as query time.
  const started = performance.now();
  try {
    let rows: T[];
    if (store.partitions && store.partitions.length > 0) {
      if (query.text.includes("WITH gaps AS")) {
        rows = runTurnGaps(store.partitions, query) as T[];
      } else if (store.partitions.length === 1) {
        const raw = store.partitions[0].db.prepare(query.text).all(...(query.params as never[])) as Record<string, unknown>[];
        rows = mergePartitionRows(query.text, raw, query.params) as T[];
      } else {
        const raw: Record<string, unknown>[] = [];
        for (const p of store.partitions) {
          if (!partitionHasRequiredTable(p.db, query.text)) continue;
          const pQuery = adaptPartitionQuery(query);
          const pRows = p.db.prepare(pQuery.text).all(...(pQuery.params as never[])) as Record<string, unknown>[];
          raw.push(...pRows);
        }
        rows = mergePartitionRows(query.text, raw, query.params) as T[];
      }
    } else if (store.db) {
      const raw = store.db.prepare(query.text).all(...(query.params as never[])) as Record<string, unknown>[];
      rows = mergePartitionRows(query.text, raw, query.params) as T[];
    } else {
      return { state: "empty", explanation: emptyExplanation };
    }
    const ms = elapsedMs(started, PANEL_CEILING_MS);
    if (rows.length === 0) return { state: "empty", explanation: emptyExplanation };
    return { state: "ok", data: rows, ms };
  } catch (err) {
    return { state: "unavailable", reason: describe(err) };
  }
}

// Expose short actionable failure reasons without replacing a failed panel with zero values.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-195
function describe(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === "SQLITE_BUSY") return "store busy — a writer holds the lock";
  if (e?.code === "SQLITE_CORRUPT") return "store file is corrupt";
  if (e?.message?.includes("no such table")) return "table missing — schema drift";
  return e?.message ? e.message.split("\n")[0] : String(err);
}

/** ISO timestamp `days` before now, the start of every panel's window. */
export function windowStart(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Open the stores for one report build; pass to `withStores` instead of this. */
function withStores<T>(fn: (stores: Stores) => Promise<T>): Promise<T> {
  const stores = openStores();
  return fn(stores).finally(() => closeStores(stores));
}

export interface CostReport {
  windowDays: number;
  generatedAt: number;
  /** Unix seconds of the first recorded row, or undefined if never measured. */
  measuringSince?: number;
  daily: Panel<unknown[]>;
  models: Panel<unknown[]>;
  durations: Panel<unknown[]>;
  coverage: { known: number; total: number; errors: number };
}

// Keep measured tool durations distinct from message-gap approximations.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-196
export function costReport(windowDays: number): CostReport {
  const generatedAt = Date.now();
  const requested = Math.floor(generatedAt / 1000) - windowDays * 86_400;

  let db;
  try {
    db = openUsageDb();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const down = { state: "unavailable" as const, reason };
    return {
      windowDays, generatedAt, daily: down, models: down, durations: down,
      coverage: { known: 0, total: 0, errors: 0 },
    };
  }

  try {
    const floor = measuringSince(db);
    if (floor === undefined) {
      // Nothing has ever been recorded. Distinct from "no spend": one is a
      // measurement, the other is the absence of one.
      const none = {
        state: "empty" as const,
        // Names the REASON, not just the absence — and the reason is
        // architectural, not a missing hook.
        //
        // Capture lives in sdk-manager's result branch, which sees sessions the
        // API executes (planned and action-executor runs). `barry start` does
        // something different: it SPAWNS the vendor CLI binary — spawn("claude",
        // ...) with stdio "inherit" — so the agent runs in a process Barry never
        // reads from. The token counts are consumed inside that process and
        // never cross back. No hook placed in Barry can see them.
        //
        // Saying "not measured" without that would send a reader looking for a
        // bug that is not there.
        explanation:
          "No usage recorded yet. Capture covers sessions the API executes "
          + "(planned and action-executor runs). Interactive `barry start` "
          + "spawns the vendor CLI with inherited stdio, so its token counts "
          + "never reach Barry and cannot be measured from here.",
      };
      return {
        windowDays, generatedAt, daily: none, models: none, durations: none,
        coverage: { known: 0, total: 0, errors: 0 },
      };
    }

    const since = Math.max(requested, floor);
    const daily = costByDay(db, since);
    const models = costByModel(db, since);
    const durations = toolDurations(db, since);
    const coverage = errorCoverage(db, since);

    // `partial` whenever the caller asked for more history than exists, so the
    // chart's shorter span is stated rather than left to be inferred.
    const clamped = requested < floor;
    const caveat = `Measuring since ${new Date(floor * 1000).toLocaleDateString()}; earlier sessions were never recorded.`;
    const wrap = <T>(rows: T[], emptyText: string): Panel<T[]> =>
      rows.length === 0
        ? { state: "empty", explanation: emptyText }
        : clamped
          ? { state: "partial", data: rows, caveat, ms: 0 }
          : { state: "ok", data: rows, ms: 0 };

    return {
      windowDays,
      generatedAt,
      measuringSince: floor,
      daily: wrap(daily, "No usage recorded in this window."),
      models: wrap(models, "No model-attributed usage in this window."),
      durations: wrap(durations, "No tool durations recorded in this window."),
      coverage,
    };
  } finally {
    db.close();
  }
}

export interface ToolIntelligence {
  windowDays: number;
  generatedAt: number;
  tools: Panel<Row[]>;
  bags: Panel<Row[]>;
  unattributed: Panel<Row[]>;
  gaps: Panel<Row[]>;
  /** Milliseconds since this report was actually rebuilt; 0 for a fresh build. */
  staleMs: number;
}

/** Why the two cross-store panels are down, stated once. */
const CROSS_STORE_REASON =
  "needs a true join across the sessions and config stores — deferred by the "
  + "seam decision recorded in DEFERRED-USAGE-QUERIES.md";

// Read tool and bag usage through the same ownership and time-window contracts.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-197
async function buildToolIntelligence(windowDays: number): Promise<Omit<ToolIntelligence, "staleMs">> {
  return withStores(async (stores) => {
    const since = windowStart(windowDays);
    const win = `the last ${windowDays} day${windowDays === 1 ? "" : "s"}`;

    const [tools, gaps] = await Promise.all([
      runPanel<Row>(stores.sessions, Q.toolLeaderboard(since), `No tool calls in ${win}.`),
      runPanel<Row>(stores.sessions, Q.turnGaps(since), `Not enough consecutive messages in ${win} to measure.`),
    ]);

    const deferred: Panel<Row[]> = { state: "unavailable", reason: CROSS_STORE_REASON };
    return { windowDays, generatedAt: Date.now(), tools, bags: deferred, unattributed: deferred, gaps };
  });
}

// Coalesce window-keyed Tool Intelligence reads so multiple polling tabs share one rebuild.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-113
const toolIntelligenceCache = new ReportCache<Omit<ToolIntelligence, "staleMs">>();

export async function toolIntelligence(windowDays: number): Promise<ToolIntelligence> {
  const cached = await toolIntelligenceCache.get(String(windowDays), () => buildToolIntelligence(windowDays));
  return { ...cached.data, staleMs: cached.staleMs };
}

export interface HealthReport {
  windowDays: number;
  generatedAt: number;
  actions: Panel<Row[]>;
  stuck: Panel<Row[]>;
  events: Panel<Row[]>;
  outcomes: Panel<Row[]>;
  /** Milliseconds since this report was actually rebuilt; 0 for a fresh build. */
  staleMs: number;
}

// Expose quiet failures as unavailable evidence rather than implying reliable operation.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-198
async function buildHealthReport(windowDays: number): Promise<Omit<HealthReport, "staleMs">> {
  return withStores(async (stores) => {
    const since = windowStart(windowDays);
    const win = `the last ${windowDays} day${windowDays === 1 ? "" : "s"}`;

    const [actions, stuck, events, outcomes] = await Promise.all([
      runPanel<Row>(stores.actions, Q.actionOutcomes(since), `No action runs in ${win}.`),
      runPanel<Row>(stores.actions, Q.stuckRuns(1), "No action runs are stuck open."),
      runPanel<Row>(stores.events, Q.eventBreakdown(since), `No events recorded in ${win}.`),
      runPanel<Row>(stores.sessions, Q.sessionOutcomes(since), `No sessions started in ${win}.`),
    ]);

    return {
      windowDays, generatedAt: Date.now(),
      actions, stuck, events, outcomes,
    };
  });
}

// Coalesce window-keyed Reliability reads so repeated polling does not duplicate the widest report.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-114
const healthReportCache = new ReportCache<Omit<HealthReport, "staleMs">>();

export async function healthReport(windowDays: number): Promise<HealthReport> {
  const cached = await healthReportCache.get(String(windowDays), () => buildHealthReport(windowDays));
  return { ...cached.data, staleMs: cached.staleMs };
}

export interface UsageOverview {
  windowDays: number;
  generatedAt: number;
  /** Present only when something is wrong with the source itself. */
  sourceWarning?: string;
  activity: Panel<Row[]>;
  bySource: Panel<Row[]>;
  byIdentity: Panel<Row[]>;
  byRepo: Panel<Row[]>;
  outcomes: Panel<Row[]>;
  models: Panel<Row[]>;
  /** Milliseconds since this report was actually rebuilt; 0 for a fresh build. */
  staleMs: number;
}

// Join identity and session aggregates without expanding them to one row per message.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-199
async function sessionsByIdentityPanel(
  stores: Stores,
  since: string,
): Promise<Panel<Row[]>> {
  const counts = await runPanel<{ identity_id: number | null; sessions: number }>(
    stores.sessions, Q.sessionCountsByIdentity(since), "no sessions",
  );
  if (counts.state !== "ok") return counts as Panel<Row[]>;
  const names = await runPanel<{ id: number; name: string }>(
    stores.identities, Q.identityNames(), "no identities",
  );
  if (names.state !== "ok") return names as Panel<Row[]>;

  const nameOf = new Map(names.data.map((n) => [n.id, n.name]));
  const rows: Row[] = counts.data
    .map((c) => ({
      identity: c.identity_id === null ? "(unattributed)" : nameOf.get(c.identity_id) ?? "(unattributed)",
      sessions: String(c.sessions),
    }))
    .sort((a, b) => Number(b.sessions) - Number(a.sessions));
  return { state: "ok", data: rows, ms: counts.ms };
}

// Assemble one usage-page response while preserving independent panel availability.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-200
async function buildUsageOverview(windowDays: number): Promise<Omit<UsageOverview, "staleMs">> {
  return withStores(async (stores) => {
    const since = windowStart(windowDays);
    const bucket = windowDays <= 2 ? "hour" as const : "day" as const;
    const win = `the last ${windowDays} day${windowDays === 1 ? "" : "s"}`;

    const [activity, bySource, byRepo, outcomes, models, byIdentity] = await Promise.all([
      runPanel<Row>(stores.sessions, Q.activity(since, bucket), `No messages in ${win}.`),
      runPanel<Row>(stores.sessions, Q.sessionsBySource(since), `No sessions started in ${win}.`),
      runPanel<Row>(stores.sessions, Q.workByRepo(since), `No sessions recorded a working directory in ${win}.`),
      runPanel<Row>(stores.sessions, Q.sessionOutcomes(since), `No sessions started in ${win}.`),
      runPanel<Row>(stores.sessions, Q.modelMix(since), `No model-attributed messages since ${Q.MODEL_ID_SINCE}.`),
      sessionsByIdentityPanel(stores, since),
    ]);

    return {
      windowDays,
      generatedAt: Date.now(),
      sourceWarning: indexWarning(stores),
      activity,
      bySource,
      byIdentity,
      byRepo,
      // Model attribution began mid-history, so this panel is `partial` by nature
      // whenever the window reaches back past that date. Saying so beats rendering
      // a truthful-looking chart of a period that was never recorded.
      models: clampNote(models, windowDays),
      outcomes,
    };
  });
}

// Cache the busiest usage page by its window so multiple tabs reuse one bounded rebuild.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-115
const usageOverviewCache = new ReportCache<Omit<UsageOverview, "staleMs">>();

export async function usageOverview(windowDays: number): Promise<UsageOverview> {
  const cached = await usageOverviewCache.get(String(windowDays), () => buildUsageOverview(windowDays));
  return { ...cached.data, staleMs: cached.staleMs };
}

// Mark pre-attribution model windows as partial even though SQL already clamps their values.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-116
function clampNote<T>(panel: Panel<T>, windowDays: number): Panel<T> {
  if (panel.state !== "ok") return panel;
  const since = new Date(Date.now() - windowDays * 86_400_000);
  if (since >= new Date(Q.MODEL_ID_SINCE)) return panel;
  return {
    state: "partial",
    data: panel.data,
    ms: panel.ms,
    caveat: `Model attribution only exists from ${Q.MODEL_ID_SINCE}; earlier messages were never recorded.`,
  };
}

// Warn when the covering index is absent so degraded query behavior does not remain invisible.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-201
function indexWarning(stores: Stores): string | undefined {
  if (stores.sessions.db && !toolIndexPresent(stores.sessions)) {
    return toolIndexMissingWarning();
  }
  return undefined;
}
