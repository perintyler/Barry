// Correlate a session across owning stores without making the dashboard a second source of truth.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-050

import type { Panel } from "./panel.js";
import type { Db } from "./store.js";

export interface SessionCost {
  sessionId: string;
  model: string | null;
  totalTokens: number;
  costUsd: number;
  durationMs: number | null;
  startedAt: number | null;
}

export interface SessionToolCall {
  name: string;
  durationMs: number;
  createdAt: number;
}

export interface SessionError {
  ts: number;
  level: number;
  service: string;
  msg: string;
  detail: string;
}

export interface WindowedRequest {
  ts: number;
  service: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export interface SessionTrace {
  sessionId: string;
  cost: Panel<SessionCost[]>;
  tools: Panel<SessionToolCall[]>;
  errors: Panel<SessionError[]>;
  /** NOT this session's requests — see the module docstring. */
  requestsInWindow: Panel<WindowedRequest[]>;
  /** Unix seconds. Undefined when the session has no usage rows to bound it. */
  window?: { from: number; to: number };
}

/** Wrap a read so a broken store reports as unavailable rather than as empty. */
function read<T>(label: string, fn: () => T[], emptyWhy: string): Panel<T[]> {
  try {
    const rows = fn();
    return rows.length
      ? { state: "ok", data: rows, ms: 0 }
      : { state: "empty", explanation: emptyWhy };
  } catch (err) {
    return { state: "unavailable", reason: `${label}: ${String(err)}` };
  }
}

export interface TraceStores {
  usage?: Db | null;
  errors?: Db | null;
  requests?: Db | null;
}

// Missing stores produce explicit gaps rather than fabricating an empty session history.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-051
export function traceSession(
  sessionId: string,
  stores: TraceStores,
  limit = 200,
): SessionTrace {
  const { usage, errors, requests } = stores;

  const cost: Panel<SessionCost[]> = usage
    ? read(
        "usage.db",
        () =>
          usage
            .prepare(
              `SELECT session_id AS sessionId, model, total_tokens AS totalTokens,
                      cost_usd AS costUsd, duration_ms AS durationMs, created_at AS startedAt
                 FROM session_usage WHERE session_id = ? ORDER BY created_at`,
            )
            .all(sessionId) as SessionCost[],
        "no usage recorded for this session",
      )
    : { state: "unavailable", reason: "usage.db not opened" };

  // Bound the request window by what the session actually did. Without usage
  // rows there is no honest window, so requests are reported unavailable rather
  // than guessed at from an arbitrary span.
  let window: { from: number; to: number } | undefined;
  if (cost.state === "ok") {
    const times = cost.data.map((c) => c.startedAt ?? 0).filter(Boolean);
    if (times.length) {
      const from = Math.min(...times);
      const last = cost.data[cost.data.length - 1];
      window = { from, to: Math.max(...times) + Math.ceil((last.durationMs ?? 0) / 1000) };
    }
  }

  const tools: Panel<SessionToolCall[]> = usage
    ? read(
        "usage.db",
        () =>
          usage
            .prepare(
              `SELECT name, duration_ms AS durationMs, created_at AS createdAt
                 FROM tool_invocation WHERE session_id = ?
                ORDER BY created_at DESC LIMIT ?`,
            )
            .all(sessionId, limit) as SessionToolCall[],
        "no tool calls recorded for this session",
      )
    : { state: "unavailable", reason: "usage.db not opened" };

  const errs: Panel<SessionError[]> = errors
    ? read(
        "errors.db",
        () =>
          errors
            .prepare(
              `SELECT ts, level, service, msg, detail FROM error_event
                WHERE json_extract(ctx, '$.sessionId') = ?
                ORDER BY ts DESC LIMIT ?`,
            )
            .all(sessionId, limit) as SessionError[],
        "this session logged no warnings or errors",
      )
    : { state: "unavailable", reason: "errors.db not opened" };

  const reqs: Panel<WindowedRequest[]> =
    requests && window
      ? read(
          "requests.db",
          () =>
            requests
              .prepare(
                `SELECT ts, service, method, path, status, duration_ms AS durationMs
                   FROM request WHERE ts BETWEEN ? AND ?
                  ORDER BY ts DESC LIMIT ?`,
              )
              .all(window.from, window.to, limit) as WindowedRequest[],
          "no HTTP traffic while this session ran",
        )
      : {
          state: "unavailable",
          reason: requests
            ? "no session window — requests can only be bounded by usage rows"
            : "requests.db not opened",
        };

  // A capped result must SAY it is capped. Sessions here run for days — one
  // measured window spanned 4.5 days with 1,343 usage rows — so `limit` rows of
  // requests out of that window is a sample, and rendering it as "the traffic"
  // would be a confident wrong answer. `partial` exists for exactly this.
  const capped = <T>(p: Panel<T[]>, what: string): Panel<T[]> =>
    p.state === "ok" && p.data.length >= limit
      ? { state: "partial", data: p.data, caveat: `showing the most recent ${limit} ${what}`, ms: p.ms }
      : p;

  return {
    sessionId,
    cost,
    tools: capped(tools, "tool calls"),
    errors: capped(errs, "events"),
    requestsInWindow: capped(reqs, "requests"),
    window,
  };
}
