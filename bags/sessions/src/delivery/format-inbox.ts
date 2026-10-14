/** All delivery surfaces render the same sender and message text.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */

import type { PromptRecord } from "../store/session-records.js";

/** How a sender is named to the recipient, when we know more than an id. */
export interface SenderIdentity {
  sessionId: string;
  name?: string | null;
}

export interface FormatInboxOptions {
  /**
   * Display names for sender sessions, keyed by session id. A name makes the
   * message legible ("session barry-d1"); without one the id still identifies
   * the sender, so this is enrichment, never a requirement.
   */
  senderNames?: ReadonlyMap<string, string | null | undefined>;
}

/** One queued message, phrased for the session reading it. */
export function formatInboxMessage(prompt: PromptRecord, options: FormatInboxOptions = {}): string {
  if (prompt.source !== "session") {
    // Everything that is not session-to-session mail reached Barry through a
    // human-facing surface (phone, web). The agent should read it as its user.
    return `New message from your phone: "${prompt.content}"`;
  }
  if (!prompt.fromSession) return `Message from another session: "${prompt.content}"`;
  const name = options.senderNames?.get(prompt.fromSession);
  const sender = name ? `${name} (${prompt.fromSession})` : prompt.fromSession;
  return `Message from session ${sender}: "${prompt.content}"`;
}

/**
 * A batch of queued messages as one block of text.
 *
 * Empty in, empty out — callers append the result only when it is non-empty,
 * so "nothing was waiting" needs no special case at each surface.
 */
export function formatInboxMessages(
  prompts: readonly PromptRecord[],
  options: FormatInboxOptions = {},
): string {
  return prompts.map((prompt) => formatInboxMessage(prompt, options)).join("\n");
}
