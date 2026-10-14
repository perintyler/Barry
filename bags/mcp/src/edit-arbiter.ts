import { escalationPrompt, answerAllows } from "@barry-rocks/locks-bag";
import type { EscalateToUser } from "./tool-runtime.js";
import { serviceAddress } from "@barry-rocks/sdk/services";

/** Escalate legitimate overlapping edits through the questions service and refuse on timeout, transport failure, or an unrecognized answer; see docs/decisions/0013-session-store-and-mcp-admission.md. */

const POLL_INTERVAL_MS = 2_000;

/**
 * How long to wait for an arbitration before giving up.
 *
 * Much shorter than the bag's four-hour default: a blocked edit holds up a
 * session that is mid-task, so an unattended conflict should resolve to
 * "blocked" while the agent can still do something else, rather than pinning
 * it for an afternoon.
 */
const ESCALATION_TTL_MINUTES = 30;

/**
 * The questions service, strictly from the registry.
 *
 * Inside a sandbox that is not running questions, this throws — and `call`
 * runs inside the arbiter's try, so the edit is blocked (fail closed) rather
 * than escalated to the real user's prod inbox.
 */
function serviceBase(): string {
  return serviceAddress("questions.api");
}

interface QuestionRecord {
  id: string;
  state: "pending" | "answered" | "expired" | "dismissed";
  answers?: Array<{ selected?: string[]; text?: string }> | null;
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const secret = process.env.BARRY_SECRET ?? "";
  const response = await fetch(`${serviceBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`questions service returned HTTP ${response.status}`);
  return response.json();
}

/**
 * What the user actually chose, flattened to the text `answerAllows` matches.
 *
 * Kept separate from the transport so the fail-closed contract can be tested
 * without a service: this is the function that decides whether a write happens.
 */
export function verdictFromQuestion(record: QuestionRecord | null): boolean {
  // Anything that is not an outright answer blocks. Expired and dismissed are
  // distinct outcomes in the bag, and both mean the same thing here — nobody
  // authorised this edit.
  if (!record || record.state !== "answered" || !record.answers?.length) return false;

  const chosen = record.answers
    .flatMap((answer) => [...(answer.selected ?? []), answer.text ?? ""])
    .filter(Boolean)
    .join(" ");

  return answerAllows(chosen);
}

export function createEditArbiter(sessionId: string): EscalateToUser {
  return async ({ path, myIntent, conflicts }) => {
    try {
      // The wrapper speaks `session`; coordinate() speaks `sessionId`.
      const prompt = escalationPrompt(
        path,
        myIntent,
        conflicts.map((c) => ({ sessionId: c.session, intent: c.intent, since: c.since })),
      );

      const created = (await call("/questions", {
        method: "POST",
        body: JSON.stringify({
          requester: "edit-coordination",
          session_id: sessionId,
          context: `Two sessions declared overlapping edits to ${path}.`,
          ttl_minutes: ESCALATION_TTL_MINUTES,
          questions: [
            {
              id: "arbitrate",
              question: prompt.question,
              header: prompt.header,
              kind: "choice",
              multiSelect: false,
              options: prompt.options,
            },
          ],
        }),
      })) as QuestionRecord;

      // Poll rather than hold a socket: the answer may arrive from a
      // notification button, the app, or the web page, and none of them know
      // this caller exists. The service's own sweeper enforces the deadline,
      // and the loop below stops regardless once the question leaves pending.
      const deadline = Date.now() + ESCALATION_TTL_MINUTES * 60_000;
      for (;;) {
        const current = (await call(`/questions/${created.id}`)) as QuestionRecord;
        if (current.state !== "pending") return verdictFromQuestion(current);

        // Belt and braces: if the sweeper is the thing that is broken, this
        // still returns rather than blocking the session forever.
        if (Date.now() > deadline) return false;

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch {
      return false;
    }
  };
}
