/** Persist capture channels so missing capture can be distinguished from a quiet agent.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */

export const CAPTURE_CHANNELS = [
  /**
   * Barry held the engine handle and saw the event directly. The only channel
   * that can be complete by construction.
   */
  "engine",
  /** Barry's own MCP tools recorded the call. The universal floor. */
  "mcp",
  /** Pushed by the vendor's OpenTelemetry (claude guest-plus). */
  "telemetry",
  /** Read from a file the vendor writes. Backfill and foreign guests. */
  "transcript",
  /** Reported by a vendor hook (cursor's postToolUse, claude's hooks). */
  "hook",
] as const;

export type CaptureChannel = (typeof CAPTURE_CHANNELS)[number];

export function isCaptureChannel(value: unknown): value is CaptureChannel {
  return typeof value === "string" && (CAPTURE_CHANNELS as readonly string[]).includes(value);
}

/**
 * How complete a channel can be, at best.
 *
 * Used to judge a session's coverage against what its mode promised: a session
 * declaring `capture: "total"` whose rows are all `transcript` has not got what
 * it said, however many rows there are.
 */
export const CHANNEL_CEILING: Record<CaptureChannel, "total" | "near-total" | "post-hoc"> = {
  engine: "total",
  // Near-total rather than total: OTel bodies truncate at 60 KB and thinking is
  // redacted, so some of what the agent did is not in the stream at all.
  telemetry: "near-total",
  hook: "near-total",
  // The floor: only calls that went through Barry's own tools.
  mcp: "post-hoc",
  // A file the vendor writes on its own schedule, in a format it may change on
  // any release (learning L6).
  transcript: "post-hoc",
};
