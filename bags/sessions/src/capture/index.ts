/**
 * How Barry learns what an agent said and did.
 *
 * Five routes, one vocabulary, and counters that tell a broken reader apart
 * from a quiet agent. See `bags/sessions/README.md` → "How a row was
 * captured".
 */

export {
  CAPTURE_CHANNELS,
  CHANNEL_CEILING,
  isCaptureChannel,
  type CaptureChannel,
} from "./channels.js";
export {
  assessCoverage,
  emptyCounters,
  summarizeCoverage,
  RATIO_ALERT_MIN_LINES,
  type CaptureAlert,
  type CaptureCounters,
} from "./coverage.js";
export {
  sweepTranscripts,
  type WatchableSession,
  type WatcherDeps,
  type SweepResult,
} from "./transcript-watcher.js";
export {
  planTracking,
  vendorFromPayload,
  providerSessionIdFromPayload,
  type TrackableVendor,
  type TrackingPlan,
  type TrackingHook,
} from "./foreign-guests.js";
export {
  telemetryToEvents,
  telemetrySpansToEvents,
  readAttributes,
  type CapturedTelemetry,
  type OtelLogsPayload,
  type OtelTracesPayload,
  type OtelLogRecord,
} from "./otel-events.js";
