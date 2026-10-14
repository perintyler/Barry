/** Translate reader vocabulary before storing, retaining the reader dedupe key and transcript channel for safe rereads and capture attribution; see docs/decisions/0013-session-store-and-mcp-admission.md. */
import { appendMessage } from "./db.js";
import { toStoreMessage, isSkipped, skipReason } from "./transcript-event.js";

/** Distinguish populated writes, hollow writes, duplicates, and skipped entries so sweep counters expose translation failures; see docs/decisions/0013-session-store-and-mcp-admission.md. */
export type PersistOutcome =
  /** Stored, with content. */
  | { outcome: "stored"; hollow: false }
  /** Stored, but the payload came through empty — a translation miss. */
  | { outcome: "stored"; hollow: true }
  /** Already present: the healthy result of a re-read. */
  | { outcome: "duplicate" }
  /** Carried no message (or an unrecognised type); nothing was written. */
  | { outcome: "skipped"; eventType: string; deliberate: boolean };

/**
 * Translate, then store.
 *
 * `persistOne` performs its own dedupe check; the one here runs BEFORE the
 * write because `appendMessage` answers null for a repeat and for a result
 * folded into its call alike, so the counters cannot learn from it.
 * Reporting a write unconditionally would make an idle sweep look busy —
 * every minute "persisting" a transcript it had already stored — and that is
 * precisely the reading the counters exist to prevent.
 */
export async function persistTranscriptEntry(
  sessionId: string,
  key: string,
  event: unknown,
): Promise<PersistOutcome> {
  const { getSessionsDb } = await import("@barry-rocks/sessions-bag/store/sessions-db");
  const { alreadyCaptured } = await import("@barry-rocks/sessions-bag/store/messages");
  if (await alreadyCaptured(getSessionsDb(), sessionId, key)) return { outcome: "duplicate" };

  // A reader yields provider events; the store takes WS-shaped messages.
  const translated = toStoreMessage(event);
  if (isSkipped(translated)) {
    return {
      outcome: "skipped",
      eventType: translated.eventType,
      // A type we chose not to carry is expected; any OTHER unrecognised type
      // means the vendor's format moved and this translation has fallen
      // behind, which the caller must be able to say out loud.
      deliberate: skipReason(translated.eventType) !== undefined,
    };
  }

  // Measured on the translated message, not the raw event: this is the claim
  // that the payload survived the vocabulary crossing, which is exactly where
  // it was being lost.
  const hollow = isHollow(translated);

  // The store numbers the row as it inserts it, so a session Barry did not
  // host needs no sequence set up first (the sweep exists for exactly those).
  await appendMessage(
    sessionId,
    { ...translated, dedupeKey: key, channel: "transcript" },
    null,
    { channel: "transcript" },
  );

  return { outcome: "stored", hollow };
}

/**
 * True when a row would be stored carrying no content.
 *
 * Only for the message types that are SUPPOSED to carry text. An `init` row
 * legitimately has none, and counting it as hollow would put a permanent
 * nonzero floor under the counter — an alarm that is always ringing is one
 * nobody reads.
 */
function isHollow(m: { type: string; content?: string; result?: string; error?: string }): boolean {
  switch (m.type) {
    case "text":
      return (m.content ?? "").trim() === "";
    case "tool_result":
      return (m.result ?? "").trim() === "";
    case "error":
      return (m.error ?? "").trim() === "";
    default:
      return false;
  }
}
