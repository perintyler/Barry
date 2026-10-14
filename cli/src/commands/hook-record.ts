/**
 * Where a foreign-guest hook event actually goes.
 *
 * Split from `hook.ts` so the decision logic there — which vendor, which
 * session, what to do when things fail — is testable without a network. This
 * file is the one part that talks to Barry, and it is deliberately thin.
 *
 * Registration is implicit: `POST /sessions/start` upserts, so the first event
 * of a chat creates the session and every later one updates it. That avoids a
 * separate "is this session known?" round trip on every hook invocation, which
 * would double the latency Barry adds to someone else's agent.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getServiceUrl } from "@barry-rocks/sdk/services";

import type { ForeignEvent } from "./hook.js";

/**
 * How long Barry gets before the turn goes on without it.
 *
 * This runs in the user's editor on every event, so an unreachable or slow
 * Barry must cost them a moment, not a turn. Short by design: losing the row
 * is the better failure.
 */
const RECORD_TIMEOUT_MS = 2_000;

/**
 * How long the relay holds at turn-end, waiting for a message.
 *
 * Must stay UNDER the vendor's own hook timeout (cursor's is configured to
 * `HOLD_SECONDS + 30`). A hold that outlives the hook is killed mid-wait,
 * which loses the message it was holding rather than leaving it queued — the
 * message is claimed from the inbox before the process dies with it.
 */
const HOLD_MS = 25_000;

/** Wait then atomically claim queued prompts from the session store; see docs/decisions/0019-cli-checkouts-and-session-selection.md. */
export async function waitForQueuedMessage(sessionId: string): Promise<string | null> {
  const { formatInboxMessages, popPrompts, waitForPrompts } = await import("@barry-rocks/sessions-bag/client");
  const ready = await waitForPrompts([sessionId], HOLD_MS);
  if (!ready.includes(sessionId)) return null;
  const prompts = await popPrompts(sessionId);
  return prompts.length > 0 ? formatInboxMessages(prompts) : null;
}

/**
 * The Barry session a hook belongs to, when Barry launched the TUI running it.
 *
 * A launched TUI carries its session's id in its environment, and its hooks
 * inherit it. Such a hook serves that session: filing its events as a
 * foreign guest's, under the vendor's own id, would make a second session
 * out of Barry's own.
 */
export function launchedSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.BARRY_SESSION_ID || null;
}

/**
 * How long a launched TUI's `stop` hook holds for a message: 90 s, under the
 * 120 s timeout its hooks.json gives it, in slices the store's long poll
 * allows.
 */
const LAUNCHED_HOLD_MS = 90_000;

/** Which turn's hold this is, and how it tells that its TUI is gone. */
export interface Hold {
  /** The turn whose end this hold serves (cursor's `generation_id`). */
  generationId?: string;
  /** Whether the TUI that ran the hook has exited. */
  parentGone?: () => boolean;
}

/**
 * Hold at a launched TUI's turn-end, delivering the first message to land.
 *
 * While it holds, a message starts a turn at once, so it tells senders so (a
 * `hook` listener promising `wake`); once it lets go nothing is listening, and
 * a sender is told the weaker truth.
 *
 * It gives up, leaving the message queued, once a newer turn's hold has taken
 * over (a person typed while it held) or its TUI has exited: either way the
 * turn it would start is not the one waiting.
 */
export async function holdForLaunchedSession(sessionId: string, hold: Hold = {}): Promise<string | null> {
  const { formatInboxMessages, popPrompts, registerListener, unregisterListener, waitForPrompts } = await import(
    "@barry-rocks/sessions-bag/client"
  );
  const newest = takeNewestHold(sessionId, hold.generationId);
  const parentGone = hold.parentGone ?? (() => process.ppid === 1);
  const deadline = Date.now() + LAUNCHED_HOLD_MS;
  try {
    while (Date.now() < deadline) {
      if (!newest() || parentGone()) return null;
      await registerListener(sessionId, "hook", "wake");
      const ready = await waitForPrompts([sessionId], Math.min(HOLD_MS, deadline - Date.now()));
      if (!ready.includes(sessionId) || !newest() || parentGone()) continue;
      const prompts = await popPrompts(sessionId);
      if (prompts.length > 0) return formatInboxMessages(prompts);
    }
    return null;
  } finally {
    await unregisterListener(sessionId, "hook").catch(() => undefined);
  }
}

/**
 * Marks this hold as the session's newest, and says later whether it still is.
 * Without a generation there is nothing to tell holds apart by, so it always is.
 */
function takeNewestHold(sessionId: string, generationId: string | undefined): () => boolean {
  if (!generationId) return () => true;
  const marker = join(tmpdir(), "barry-holds", createHash("sha256").update(sessionId).digest("hex").slice(0, 16));
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, generationId);
  } catch {
    return () => true;
  }
  return () => {
    try {
      return readFileSync(marker, "utf8") === generationId;
    } catch {
      return true;
    }
  };
}

export async function recordForeignEvent(event: ForeignEvent): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.BARRY_SECRET) headers.Authorization = `Bearer ${process.env.BARRY_SECRET}`;

  const response = await fetch(`${getServiceUrl("api")}/api/v1/sessions/start`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      // The vendor's own id IS the Barry session id for a foreign guest: Barry
      // never launched it, so there is no BARRY_SESSION_ID to have stamped.
      sessionId: launchedSessionId() ?? event.providerSessionId,
      providerSessionId: event.providerSessionId,
      provider: event.vendor,
      // No mode: Barry did not launch this session and chose no mode for it.
      // Recorded as absent rather than guessed, so the session's real
      // guarantees are not overstated.
      source: launchedSessionId() ? "cli" : "foreign",
      ...(launchedSessionId() && process.env.BARRY_MODE ? { mode: process.env.BARRY_MODE } : {}),
      transcriptPath: event.payload.transcriptPath ?? event.payload.transcript_path,
      cwd: typeof event.payload.cwd === "string" ? event.payload.cwd : Array.isArray(event.payload.workspacePaths) ? event.payload.workspacePaths[0] : null,
    }),
    signal: AbortSignal.timeout(RECORD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`sessions/start returned HTTP ${response.status}`);
  }
}
