import {
  getSession,
  buildSessionHistoryContext,
  getSessionMessageCounts,
  listSessions,
  updateSessionMetadata,
} from "@barry-rocks/sessions-bag/client";
import { getServiceUrl } from "@barry-rocks/sdk/services";
import { installedModels } from "@barry-rocks/sdk/adapters/models";
import type { ModelRef } from "@barry-rocks/sdk/ids";
import { freemem } from "node:os";
import { refuseSummary, type SummaryRefusal } from "./summary-admission.js";
import { completeOnWorkers, workerOffersSummaries } from "./summary-on-workers.js";

/** Scheduled summaries use a local completion model that can produce the required markdown sections. */
const SUMMARY_MODEL: ModelRef = "ollama/qwen3:8b";

/**
 * An 8B holds about 5 GB; summaries come minutes apart, so the model is let
 * go a minute after each one instead of staying resident.
 */
const SUMMARY_KEEP_ALIVE_MS = 60_000;
/** A cold 8B load plus 1024 tokens; measured calls took 41-46s warm. */
const SUMMARY_TIMEOUT_MS = 180_000;

/**
 * The summary as the stream should hold it: thinking blocks removed, and
 * anything before the first requested section dropped. A local model can
 * narrate its reasoning first; that is not a summary, and a reply with none
 * of the sections is not stored at all.
 */
export function summaryText(raw: string): string | null {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
  const start = text.search(/^#{2,3}\s*(Done|Open Loops|Suggested Next Steps)\b/m);
  return start === -1 ? null : text.slice(start).trim();
}

/** Diagnostics go to stderr: the job's stdout carries only its JSON result. */
const note = (line: string) => process.stderr.write(`[summarize-sessions] ${line}\n`);

/** Minimum quiet period before a session is eligible for summarization. */
export const DEFAULT_QUIET_MS = 15 * 60 * 1000;
/** Only sessions active this recently are considered, so a first sweep does not summarize history. */
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Model calls per sweep; the rest wait for the next one. */
export const DEFAULT_MAX_SESSIONS = 4;
const SCAN_LIMIT = 200;

export interface SummaryCandidate {
  id: string;
  last_message_at: string | null;
  metadata: { summary_watermark_seq?: number | null; [key: string]: unknown };
}

/**
 * Whether a session is due a summary: it gained messages since the last one
 * (the watermark), and has been quiet for `quietMs` — but not so long that it
 * predates the lookback window. Pure, so the rule is testable without a store.
 */
export function isSummaryDue(session: SummaryCandidate, messageCount: number, now: Date, options: { quietMs?: number; lookbackMs?: number } = {}): boolean {
  if (!session.last_message_at) return false;
  const lastActivity = Date.parse(session.last_message_at);
  const quietFor = now.getTime() - lastActivity;
  if (quietFor < (options.quietMs ?? DEFAULT_QUIET_MS) || quietFor > (options.lookbackMs ?? DEFAULT_LOOKBACK_MS)) return false;
  return messageCount > (session.metadata.summary_watermark_seq ?? 0);
}

export interface SummarySweepDeps {
  now?: Date;
  quietMs?: number;
  lookbackMs?: number;
  maxSessions?: number;
  freeBytes?: () => number;
  /** Throws to leave the session for the next sweep (its watermark stays put). */
  generate?: (sessionId: string, watermark: number) => Promise<{ content: string; status: string } | null>;
  /**
   * Where the model runs: this machine, or a worker through the
   * summarize-session job. `auto` (the default) asks the workflows owner
   * whether a live worker offers the job, and runs locally when none does.
   */
  on?: "local" | "workers" | "auto";
  /** Append the summary to the session's stream, through the API's message route. */
  persist?: (sessionId: string, content: string, status: string) => Promise<void>;
}

export interface SummarySweepResult {
  considered: number;
  summarized: number;
  /** Why the sweep stopped early, when it did. */
  refused?: SummaryRefusal;
}

/**
 * Persist a summary through the API's message route, which appends it in turn
 * with the other messages it is appending for the session.
 */
async function persistThroughApi(sessionId: string, content: string, status: string): Promise<void> {
  const secret = process.env.BARRY_SECRET;
  const response = await fetch(`${getServiceUrl("api")}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/persist`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ type: "summary", content, metadata: { status } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`the API refused the summary (${response.status})`);
}

/**
 * Summarize quiet sessions sequentially up to maxSessions, recording a durable
 * watermark. Check memory admission before each model call.
 * See docs/decisions/0035-session-route-and-summary-rationale.md.
 */
export async function summarizeQuietSessions(deps: SummarySweepDeps = {}): Promise<SummarySweepResult> {
  const now = deps.now ?? new Date();
  const configured = deps.on ?? (["local", "workers"].includes(process.env.BARRY_SUMMARY_ON ?? "") ? process.env.BARRY_SUMMARY_ON as "local" | "workers" : "auto");
  const on = configured === "auto" ? (await workerOffersSummaries() ? "workers" : "local") : configured;
  const generate = deps.generate ?? (on === "workers" ? generateSessionSummaryOnWorkers : generateSessionSummary);
  const persist = deps.persist ?? persistThroughApi;
  const maxSessions = deps.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = await listSessions({ limit: SCAN_LIMIT, includeArchived: false, orderBy: "activity" }) as SummaryCandidate[];
  const counts = await getSessionMessageCounts(sessions.map((s) => s.id));
  const due = sessions.filter((s) => isSummaryDue(s, counts.get(s.id) ?? 0, now, deps));
  const result: SummarySweepResult = { considered: due.length, summarized: 0 };

  for (const session of due.slice(0, maxSessions)) {
    // The memory admission is about this machine's model; a worker's is its own.
    const refusal = on === "local" ? refuseSummary({ freeBytes: (deps.freeBytes ?? freemem)(), lastSummaryAt: null, now, inFlight: false }) : null;
    if (refusal) {
      note(`stopping: ${refusal} (free ${(deps.freeBytes ?? freemem)()} bytes)`);
      result.refused = refusal;
      break;
    }
    let summary: { content: string; status: string } | null;
    try {
      summary = await generate(session.id, counts.get(session.id) ?? 0);
    } catch (error) {
      note(`${session.id}: ${error instanceof Error ? error.message : String(error)}; left for the next sweep`);
      continue;
    }
    if (summary) {
      await persist(session.id, summary.content, summary.status);
      result.summarized++;
    } else {
      note(`${session.id}: nothing to summarize`);
    }
    // Re-read after persisting: the summary is itself a message, and a
    // watermark below it would make the summary look like new activity.
    const watermark = (await getSessionMessageCounts([session.id])).get(session.id) ?? counts.get(session.id) ?? 0;
    await updateSessionMetadata(session.id, { summary_watermark_seq: watermark, summary_updated_at: new Date().toISOString() });
  }
  return result;
}

/** The prompt for one session's wrap-up, or null when it has too little history to summarize. */
async function summaryPrompt(sessionId: string): Promise<{ prompt: string; status: string } | null> {
  const session = await getSession(sessionId);
  if (!session) return null;

  const historyContext = await buildSessionHistoryContext(sessionId);
  if (!historyContext || historyContext.length < 50) {
    return null;
  }

  const prompt = `You are summarizing progress on a session after recent activity.

<session-directive>
${session.system_prompt || "No directive provided"}
</session-directive>

<session-status>${session.status}</session-status>

${historyContext}

Generate a concise wrap-up summary with exactly these sections (omit a section only if it has nothing to report):

### Done
- Bullet list of completed work (1-4 items max)

### Open Loops
Each open loop numbered with a unique ID. Use format \`OL-XXXXXX\` where XXXXXX is the first 6 characters of a UUID.

1. **OL-a3f2c1** - Description of the open loop

Categories to check: anything started but not finished, decisions deferred, TODOs mentioned but not addressed, tests not run, docs not updated.

### Suggested Next Steps
- What to pick up next (1-3 items, only if relevant)

Be concise. Use plain markdown bullet points.`;
  return { prompt, status: session.status };
}

/** Ask the summary model for a wrap-up of one session, or null when there is nothing to say. */
export async function generateSessionSummary(sessionId: string): Promise<{ content: string; status: string } | null> {
  const request = await summaryPrompt(sessionId);
  if (!request) return null;
  const { prompt } = request;
  try {
    const result = await installedModels().completion(SUMMARY_MODEL).complete({
      maxTokens: 1024,
      prompt,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      keepAliveMs: SUMMARY_KEEP_ALIVE_MS,
    });

    const content = summaryText(result.text ?? "");
    if (!content) {
      note(`${sessionId}: ${SUMMARY_MODEL} returned none of the sections`);
      return null;
    }
    return { content, status: request.status };
  } catch (error) {
    note(`${sessionId}: generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The same wrap-up with the model call made by a worker (summary-on-workers.ts).
 * Throws when the run failed or is still waiting, so the sweep leaves the
 * session for next time rather than marking it summarized.
 */
export async function generateSessionSummaryOnWorkers(sessionId: string, watermark: number): Promise<{ content: string; status: string } | null> {
  const request = await summaryPrompt(sessionId);
  if (!request) return null;
  const text = await completeOnWorkers(request.prompt, SUMMARY_MODEL.replace(/^ollama\//, ""), `summary-${sessionId}-${watermark}`);
  const content = summaryText(text);
  if (!content) {
    note(`${sessionId}: the worker's model returned none of the sections`);
    return null;
  }
  return { content, status: request.status };
}
