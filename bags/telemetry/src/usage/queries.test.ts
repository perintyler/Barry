import { describe, it, expect } from "vitest";
import * as Q from "./queries.js";

// Test query text and parameters so silent clamp, exclusion and placeholder regressions fail locally.
// Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-165

const SINCE = "2026-08-01T00:00:00.000Z";

const ALL: Array<[string, Q.Query]> = [
  ["activity", Q.activity(SINCE, "day")],
  ["sessionsBySource", Q.sessionsBySource(SINCE)],
  ["sessionCountsByIdentity", Q.sessionCountsByIdentity(SINCE)],
  ["workByRepo", Q.workByRepo(SINCE)],
  ["sessionOutcomes", Q.sessionOutcomes(SINCE)],
  ["modelMix", Q.modelMix(SINCE)],
  ["toolLeaderboard", Q.toolLeaderboard(SINCE)],
  ["bagUsage", Q.bagUsage(SINCE)],
  ["turnGaps", Q.turnGaps(SINCE)],
  ["actionOutcomes", Q.actionOutcomes(SINCE)],
  ["eventBreakdown", Q.eventBreakdown(SINCE)],
];

describe("usage queries", () => {
  it.each(ALL)("%s takes its window as a bound parameter", (_name, query) => {
    // The window must never be interpolated: a query that formats a date into
    // its own text cannot be prepared, and is one refactor from taking a value
    // that did not come from us.
    expect(query.text).toContain("?");
    expect(query.params[0]).toBe(SINCE);
    expect(query.text).not.toContain(SINCE);
  });

  it.each(ALL)("%s binds every placeholder it declares", (_name, query) => {
    // Anonymous placeholders cannot be reused, so a repeated bound value must
    // be passed once per occurrence — this catches the arity
    // mismatch better-sqlite3 throws on first call, when someone is watching
    // the page instead of the suite.
    const placeholders = (query.text.match(/\?/g) ?? []).length;
    expect(query.params).toHaveLength(placeholders);
  });

  // These queries could regress to interpolating a limit or a bucket directly
  // into the text. Every non-window parameter must arrive through the params
  // array too, never the text.
  it.each(ALL)("%s interpolates no parameter value into its text", (_name, query) => {
    for (const param of query.params) {
      if (typeof param === "string" && param.length > 3) {
        expect(query.text).not.toContain(param);
      }
    }
  });

  // Clamp model reports to the attribution start so unobserved history is not charted as zero usage.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-095
  it("clamps the model window to when attribution began", () => {
    const q = Q.modelMix(SINCE);
    expect(q.text).toContain("max(?, ?)");
    expect(q.params[1]).toBe(Q.MODEL_ID_SINCE);
  });

  // Exclude human-response tools from latency rankings because their delays measure people, not the system.
  // Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-166
  it("excludes human-in-the-loop tools from the turn-gap ranking", () => {
    const q = Q.turnGaps(SINCE);
    expect(Q.GAP_EXCLUDED_TOOLS).toContain("AskUserQuestion");
    expect(q.params).toEqual([SINCE, ...Q.GAP_EXCLUDED_TOOLS, 20]);
    expect(q.text).toContain("NOT IN");
  });

  // Bucket code comes from a closed enum; the time window is the only SQL parameter.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-096
  it("binds only the window in the activity query", () => {
    const day = Q.activity(SINCE, "day");
    const hour = Q.activity(SINCE, "hour");
    expect(day.params).toEqual([SINCE]);
    expect(hour.params).toEqual([SINCE]);
    expect(hour.text).toContain("%Y-%m-%dT%H:00:00Z");
    expect(day.text).toContain("%Y-%m-%dT00:00:00Z");
  });

  // Clamp overnight gaps so a paused session cannot dominate a tool’s inferred latency percentile.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-097
  it("clips turn gaps so a paused session cannot own the p95", () => {
    expect(Q.turnGaps(SINCE).text).toContain("BETWEEN 0 AND 900");
  });

  // Preserve rank-based p95 in SQLite; replacing it with max would mislabel the statistic.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-098
  it("computes percentiles by rank-and-pick, not by max", () => {
    const q = Q.turnGaps(SINCE).text;
    expect(q).toContain("ceil(0.5");
    expect(q).toContain("ceil(0.95");
    expect(q).toContain("row_number() OVER (PARTITION BY name ORDER BY gap_s)");
    expect(q).not.toContain("max(gap_s)");
  });

  // Convert ISO timestamps through julianday before computing elapsed seconds.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-099
  it("measures durations through julianday, not string subtraction", () => {
    expect(Q.turnGaps(SINCE).text).toContain("julianday(lead(created_at)");
    expect(Q.actionOutcomes(SINCE).text).toContain(
      "(julianday(completed_at) - julianday(started_at)) * 86400",
    );
    expect(Q.stuckRuns(1).text).toContain("(julianday('now') - julianday(started_at)) * 24");
  });

  // Keep sessions with no identity so grouped totals agree with other reports.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-100
  it("carries null identity ids so the merge can label them", () => {
    expect(Q.sessionCountsByIdentity(SINCE).text).toContain("identity_id");
    expect(Q.sessionCountsByIdentity(SINCE).text).not.toContain("WHERE identity_id IS NOT NULL");
  });

  // Preaggregate message counts before joining sessions to avoid row explosion and repeated path normalization.
  // Rationale: docs/decisions/0006-telemetry-usage-and-rendering-invariants.md#note-167
  it("pre-aggregates tool calls before joining sessions", () => {
    const text = Q.workByRepo(SINCE).text;
    expect(text).toContain("WITH calls AS");
    // Normalization runs over grouped sessions, not over the message join.
    expect(text.indexOf("WITH calls AS")).toBeLessThan(text.indexOf("repo_of("));
  });

  // A partial single-file ROI query cannot stand in for the absent cross-store report.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-101
  it("leaves the cross-store ROI queries out rather than faking them", () => {
    expect(Q).not.toHaveProperty("bagRoi");
    expect(Q).not.toHaveProperty("unattributedCalls");
  });

  // Escape underscores in MCP-name LIKE filters so ordinary tool names do not match as MCP.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-102
  it("escapes the mcp prefix match for LIKE", () => {
    expect(Q.bagUsage(SINCE).text).toContain("LIKE 'mcp\\_\\_%' ESCAPE '\\'");
  });

  // Stuck runs remain reportable even when their start falls outside the requested recent window.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-103
  it("finds stuck runs regardless of the page's time window", () => {
    const q = Q.stuckRuns(1);
    // Its only parameter is the minimum age; there is no `since`.
    expect(q.params).toEqual([1]);
    expect(q.text).toContain("completed_at IS NULL");
    expect(q.text).not.toContain("started_at >=");
  });

  // Use the stored complete status; a plausible completed spelling would misclassify finished runs.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-104
  it("treats both spellings of a finished run as finished", () => {
    const text = Q.stuckRuns(1).text;
    expect(text).toContain("'complete'");
    expect(text).toContain("'completed'");
    expect(text).toContain("'cancelled'");
  });
});
