/** Derive delivery reports from live listener registration and session state.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */

import { strongestGuarantee, type DeliveryGuarantee } from "./guarantees.js";

export interface DeliveryReportInput {
  /** Strongest guarantee among the recipient's live listeners. */
  listenerGuarantee: DeliveryGuarantee;
  /** Is the recipient session still open? */
  active: boolean;
  /** True when the wake budget refused this wake (.1 invariant 3). */
  throttled?: boolean;
  /**
   * False when this session's conversation runs in a Barry-owned engine that
   * is no longer running.
   *
   * Absent means "this session does not depend on an engine" — a guest-tier
   * session has none, and treating that as a dead one would report every
   * claude guest-plus session `on-resume`.
   *
   * A hosted session whose engine was `kill -9`'d keeps its listener
   * registration until the heartbeat lapses, so without this a sender is
   * promised a `wake` that nothing can deliver.
   */
  engineAlive?: boolean;
}

export interface DeliveryReport {
  delivery: DeliveryGuarantee;
  /** One sentence the sender can act on. */
  explanation: string;
}

const EXPLANATIONS: Record<DeliveryGuarantee, string> = {
  wake: "The session is idle with a live listener — it will start a turn now.",
  "wake-peer-framed":
    "The session will start a turn now. Its agent sees the message framed as mail from another session, not as its user.",
  "turn-end": "The session is running — it will read this when its current turn ends.",
  "tool-call": "No inbox listener — the session reads this on its next Barry tool call.",
  "on-resume": "The session is not running. The message is held and delivered when it resumes.",
  none: "Nothing is listening and the session cannot be reached. The message stays queued.",
};

export function reportDelivery(input: DeliveryReportInput): DeliveryReport {
  // Held, not lost: the prompt row outlives the process, and the session
  // drains its inbox when it comes back.
  if (!input.active) return { delivery: "on-resume", explanation: EXPLANATIONS["on-resume"] };

  // A session whose engine died cannot be woken, whatever its listener still
  // claims — the registration outlives the process by up to a heartbeat. This
  // is checked BEFORE the listener is consulted, because the listener is
  // exactly what would otherwise answer `wake`.
  if (input.engineAlive === false) {
    return {
      delivery: "on-resume",
      explanation:
        "This session's engine is no longer running. The message is held and delivered when the session is resumed.",
    };
  }

  if (input.throttled) {
    // Over budget, the message is NOT dropped — it loses only its wake, and
    // falls back to whatever the session would have read anyway.
    return {
      delivery: "tool-call",
      explanation:
        "Wake budget reached for this recipient — the message stays queued and is read on the session's next Barry tool call.",
    };
  }

  // Every live Barry session drains its inbox on its next MCP tool result, so
  // `tool-call` is the floor for an active session rather than `none`.
  const delivery = strongestGuarantee(input.listenerGuarantee, "tool-call");
  return { delivery, explanation: EXPLANATIONS[delivery] };
}
