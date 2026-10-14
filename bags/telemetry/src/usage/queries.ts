// Usage queries return SQL and parameters separately so callers retain parameterization.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-168

export interface Query {
  text: string;
  params: unknown[];
}

// Clamp model reports to the date model IDs became available; earlier unknown rows would bias rankings.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-169
export const MODEL_ID_SINCE = "2026-08-19";

// Exclude named human-response tools before computing turn-gap rankings.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-170
export const GAP_EXCLUDED_TOOLS = ["AskUserQuestion", "Agent"];

/** Messages and sessions per bucket, split by type. Drives the sparkline row. */
export function activity(sinceIso: string, bucket: "hour" | "day"): Query {
  // Interpolate the closed bucket enum and bind only the time window so placeholder order remains correct.
  // Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-032
  const fmt = bucket === "hour" ? "%Y-%m-%dT%H:00:00Z" : "%Y-%m-%dT00:00:00Z";
  return {
    text: `
      SELECT strftime('${fmt}', created_at) AS bucket,
             sum(CASE WHEN type = 'tool_call' THEN 1 ELSE 0 END)                      AS tool_calls,
             sum(CASE WHEN type = 'message' AND role = 'assistant' THEN 1 ELSE 0 END) AS assistant,
             sum(CASE WHEN type = 'message' AND role = 'user' THEN 1 ELSE 0 END)      AS user_msgs,
             count(DISTINCT session_id)                                               AS sessions
      FROM messages
      WHERE created_at >= ?
      GROUP BY 1
      ORDER BY 1`,
    params: [sinceIso],
  };
}

/** Sessions grouped by how they were started (cli, action-executor, mcp...). */
export function sessionsBySource(sinceIso: string): Query {
  return {
    text: `
      SELECT COALESCE(NULLIF(json_extract(metadata, '$.source'), ''), '(unset)') AS source,
             count(*)        AS sessions,
             max(created_at) AS last_seen
      FROM sessions
      WHERE created_at >= ? AND json_type(metadata) = 'object'
      GROUP BY 1
      ORDER BY sessions DESC`,
    params: [sinceIso],
  };
}

// Read session-per-identity counts from their owning store without joining every message.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-171
export function sessionCountsByIdentity(sinceIso: string): Query {
  return {
    text: `
      SELECT identity_id, count(*) AS sessions
      FROM sessions
      WHERE created_at >= ?
      GROUP BY 1`,
    params: [sinceIso],
  };
}

/** The id→name side of the identity merge, from the identities store. */
export function identityNames(): Query {
  return {
    text: `SELECT id, name FROM identities`,
    params: [],
  };
}

// Fold worktrees through the registered repo_of function before grouping repository usage.
// Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-105
export function workByRepo(sinceIso: string, limit = 15): Query {
  // Tool calls are counted ONCE per session in a CTE and then joined, rather than
  // joining messages to sessions and counting afterwards. Both forms give the same
  // answer; the join-then-count version measured 2,693ms against 51ms, because
  // it expands to one row per message before grouping and re-runs the path
  // normalization on every one. The reasoning is about row expansion, which
  // holds in any engine.
  return {
    text: `
      WITH calls AS (
        SELECT session_id, count(*) AS calls
        FROM messages
        WHERE type = 'tool_call' AND created_at >= ?
        GROUP BY 1
      )
      SELECT repo_of(json_extract(s.metadata, '$.working_directory')) AS repo,
             count(*)                      AS sessions,
             COALESCE(sum(calls.calls), 0) AS tool_calls
      FROM sessions s
      LEFT JOIN calls ON calls.session_id = s.id
      WHERE s.created_at >= ?
        AND json_type(s.metadata) = 'object'
        AND COALESCE(json_extract(s.metadata, '$.working_directory'), '') <> ''
      GROUP BY 1
      ORDER BY tool_calls DESC, sessions DESC
      LIMIT ?`,
    // The window value appears twice (once per CTE branch) because anonymous
    // placeholders cannot be reused — each occurrence binds separately.
    params: [sinceIso, sinceIso, limit],
  };
}

/** Terminal states of sessions started in the window. */
export function sessionOutcomes(sinceIso: string): Query {
  return {
    text: `
      SELECT status, count(*) AS sessions
      FROM sessions
      WHERE created_at >= ?
      GROUP BY 1
      ORDER BY sessions DESC`,
    params: [sinceIso],
  };
}

// Rank recorded model IDs within their supported observation window.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-172
export function modelMix(sinceIso: string): Query {
  return {
    text: `
      SELECT COALESCE(mo.label, mo.model_id, '(unknown)') AS model,
             count(*) AS messages
      FROM messages m
      JOIN models mo ON mo.id = m.model_id
      WHERE m.created_at >= max(?, ?)
      GROUP BY 1
      ORDER BY messages DESC`,
    params: [sinceIso, MODEL_ID_SINCE],
  };
}

/** Most-called tools. This is the query the covering index exists for. */
export function toolLeaderboard(sinceIso: string, limit = 30): Query {
  return {
    text: `
      SELECT name AS tool,
             count(*)                   AS calls,
             count(DISTINCT session_id) AS sessions
      FROM messages
      WHERE type = 'tool_call' AND created_at >= ? AND name IS NOT NULL
      GROUP BY 1
      ORDER BY calls DESC
      LIMIT ?`,
    params: [sinceIso, limit],
  };
}

// Attribute MCP calls to the serving bag rather than treating each tool name as an unrelated owner.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-173
export function bagUsage(sinceIso: string): Query {
  return {
    text: `
      SELECT bag_of(name)          AS bag,
             count(*)              AS calls,
             count(DISTINCT session_id) AS sessions,
             max(created_at)       AS last_used
      FROM messages
      WHERE type = 'tool_call' AND created_at >= ? AND name LIKE 'mcp\\_\\_%' ESCAPE '\\'
      GROUP BY 1
      ORDER BY calls DESC`,
    params: [sinceIso],
  };
}

// Message gaps approximate elapsed time, not direct tool execution duration.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-174
export function turnGaps(sinceIso: string, minSamples = 20): Query {
  // Placeholder order matches textual appearance: the window first, then the
  // NOT IN list, then the HAVING threshold. Anonymous placeholders cannot be
  // reused and bind by position, and a mismatch does not error — it binds "20"
  // against a tool name and quietly renders an empty panel.
  const excluded = GAP_EXCLUDED_TOOLS.map(() => "?").join(", ");
  return {
    text: `
      WITH gaps AS (
        SELECT name,
               (julianday(lead(created_at) OVER (PARTITION BY session_id ORDER BY sequence))
                - julianday(created_at)) * 86400 AS gap_s
        FROM messages
        WHERE created_at >= ?
      ),
      ranked AS (
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
      LIMIT 25`,
    params: [sinceIso, ...GAP_EXCLUDED_TOOLS, minSamples],
  };
}

// Aggregate action outcomes using their stored statuses and completed durations.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-175
export function actionOutcomes(sinceIso: string): Query {
  return {
    text: `
      SELECT bag, action, status,
             count(*) AS runs,
             sum((julianday(completed_at) - julianday(started_at)) * 86400) AS total_s,
             count((julianday(completed_at) - julianday(started_at)) * 86400) AS timed,
             max(started_at) AS last_run
      FROM action_runs
      WHERE started_at >= ?
      GROUP BY 1, 2, 3
      ORDER BY runs DESC`,
    params: [sinceIso],
  };
}

// Report unfinished runs explicitly rather than treating an absent finish time as success.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-176
export function stuckRuns(minHours = 1): Query {
  return {
    text: `
      SELECT bag, action, status,
             count(*) AS open,
             round(max((julianday('now') - julianday(started_at)) * 24), 1) AS oldest_hours
      FROM action_runs
      WHERE completed_at IS NULL
        AND status NOT IN ('complete', 'completed', 'cancelled')
      GROUP BY 1, 2, 3
      HAVING max((julianday('now') - julianday(started_at)) * 24) >= ?
      ORDER BY oldest_hours DESC`,
    params: [minHours],
  };
}

/** Events by kind and severity — the notification stream's own health. */
export function eventBreakdown(sinceIso: string): Query {
  return {
    text: `
      SELECT type, severity, source,
             count(*)        AS events,
             max(created_at) AS latest
      FROM events
      WHERE created_at >= ?
      GROUP BY 1, 2, 3
      ORDER BY events DESC`,
    params: [sinceIso],
  };
}
