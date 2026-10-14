// Durable alert events let other bags react without coupling delivery to the sampler.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-006

import { apiBaseUrl, apiSecret } from "./framework/endpoints.js";

const TIMEOUT_MS = 3000;

export interface AlertEventInput {
  /** The rule that fired, e.g. "error-spike". Carried so a subscriber can group on it. */
  ruleId: string;
  /** Rendered sentence, the same text the Slack message carries. */
  text: string;
  severity: "warn" | "critical";
  /** The rule's identity labels, e.g. `{service: "api"}`. */
  labels: Record<string, string>;
}

export interface RecoveryEventInput {
  ruleId: string;
  detail: string;
  durationSec: number;
}

export type RecordResult = { ok: true } | { ok: false; reason: string };

async function post(body: unknown): Promise<RecordResult> {
  // An empty string is unset, not a secret — `??` would accept it and then 403.
  const secret = apiSecret();
  if (!secret) return { ok: false, reason: "BARRY_SECRET not set" };

  try {
    const res = await fetch(`${apiBaseUrl()}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `api returned ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// Record firing evidence separately from delivery so a failed channel cannot erase the alert.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-007
export function recordAlertEvent(alert: AlertEventInput): Promise<RecordResult> {
  return post({
    type: "system_alert",
    source: "telemetry",
    title: alert.text,
    severity: alert.severity === "critical" ? "error" : "warn",
    data: { ruleId: alert.ruleId, labels: alert.labels, state: "firing" },
  });
}

// Recovery events retain the firing identity so downstream consumers can correlate the transition.
// Rationale: docs/decisions/0003-telemetry-collector-invariants.md#note-008
export function recordRecoveryEvent(recovery: RecoveryEventInput): Promise<RecordResult> {
  return post({
    type: "system_alert",
    source: "telemetry",
    title: `Recovered: ${recovery.detail}`,
    severity: "success",
    data: {
      ruleId: recovery.ruleId,
      state: "resolved",
      durationSec: recovery.durationSec,
    },
  });
}
