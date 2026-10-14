// Scrape hook counters from their owning API so silent hook failures become observable.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-014

import type { MetricPoint } from "./schema.js";
import { METRICS } from "./schema.js";
import { apiBaseUrl, apiSecret } from "./framework/endpoints.js";

// Bound loopback hook reads to one second to keep a hung API from exhausting the base tick.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-015
const TIMEOUT_MS = 1000;



interface HookCountersBody {
  dispatches?: number;
  failures?: Record<string, number>;
}

// Emit collector health on every scrape so an unavailable API differs from zero hook activity.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-016
export async function collectHooks(now: number): Promise<MetricPoint[]> {
  // Health success and failure share tool identity so no-data rules follow one continuous series.
  // Rationale: docs/decisions/0008-telemetry-regression-contracts.md#note-007
  const ok = (): MetricPoint => ({
    ts: now,
    metric: METRICS.collectorOk.name,
    value: 1,
    labels: { tool: "hooks" },
  });

  // Distinguish missing configuration, transport, HTTP and malformed responses for actionable repairs.
  // Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-017
  const failed = (reason: "unconfigured" | "unreachable" | "http" | "malformed"): MetricPoint => ({
    ts: now,
    metric: METRICS.collectorOk.name,
    value: 0,
    labels: { tool: "hooks", reason },
  });

  // `/api/v1/*` is behind the API's auth middleware; only `/health` is
  // registered ahead of it. Without this the scrape 403s, which this function
  // then reports as "unreachable" — indistinguishable from the API being down,
  // and exactly how the first version of this collector stayed quiet.
  const secret = apiSecret();
  if (!secret) return [failed("unconfigured")];

  let body: HookCountersBody | null = null;
  try {
    const res = await fetch(`${apiBaseUrl()}/events/hook-counters`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [failed("http")];
    body = (await res.json()) as HookCountersBody;
  } catch {
    // Refused, timed out, or a body that would not parse. One label, because
    // from here they are one repair: the API is not answering usefully. A
    // non-2xx is split out above precisely because it is NOT that -- something
    // answered, and at 403 the fix is the credential rather than the service.
    return [failed("unreachable")];
  }

  if (typeof body?.dispatches !== "number" || !Number.isFinite(body.dispatches)) {
    // Reachable but not answering the shape we asked for, which is a different
    // fault from being down and must not masquerade as healthy data.
    return [failed("malformed")];
  }

  const points: MetricPoint[] = [
    ok(),
    { ts: now, metric: METRICS.hookDispatches.name, value: body.dispatches },
  ];

  for (const [bag, count] of Object.entries(body.failures ?? {})) {
    if (typeof count !== "number" || !Number.isFinite(count)) continue;
    points.push({
      ts: now,
      metric: METRICS.hookFailures.name,
      value: count,
      labels: { bag },
    });
  }

  return points;
}
