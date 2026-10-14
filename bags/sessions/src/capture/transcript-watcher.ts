/** Sweep available guest transcript readers and persist new entries idempotently.
 * Rationale: docs/decisions/0034-adapter-build-capture-and-relay-rationale.md.
 */

import type { TranscriptSource } from "@barry-rocks/sdk/transcripts";
import { assessCoverage, emptyCounters, summarizeCoverage, type CaptureCounters } from "./coverage.js";

/** A session this sweep might read. */
export interface WatchableSession {
  id: string;
  /** Which adapter ran it. */
  provider: string;
  providerSessionId?: string | null;
  cwd?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Whether Barry held the engine.
   *
   * A hosted session is SKIPPED — its capture is the engine's, and reading its
   * file would double every row and misattribute the completeness.
   */
  host?: "hosted" | "guest" | null;
}

/**
 * What became of one entry handed to `persist`.
 *
 * Declared here rather than imported from the persister: the sweep is in the
 * sessions bag and the persister lives in its API service, so the dependency
 * runs this way. The persister's own type structurally satisfies this.
 */
export type PersistEntryOutcome =
  | { outcome: "stored"; hollow: boolean }
  | { outcome: "duplicate" }
  | { outcome: "skipped"; eventType: string; deliberate: boolean };

export interface WatcherDeps {
  /** Sessions to consider this sweep. */
  listSessions(): Promise<WatchableSession[]>;
  /** The reader for an adapter, or undefined if this deployment has none. */
  resolveReader(provider: string): TranscriptSource | undefined;
  /**
   * Persist one entry, reporting what became of it.
   *
   * Four outcomes, not a boolean. "Already there" is the healthy result of a
   * re-read and must not read as a write, or an idle sweep looks busy — but
   * "written empty" must not read as a write either, and a bare boolean could
   * not say so. A sweep reported `persisted=3762` while 99.5% of those rows
   * held no content.
   */
  persist(sessionId: string, key: string, event: unknown): Promise<PersistEntryOutcome>;
  /** Where problems go: a failed session, an unrecognised event, an alert. */
  report(line: string): void;
  /**
   * Where each sweep's counters go.
   *
   * Kept apart from `report` so a healthy sweep is not a problem: routed
   * through it, every idle minute logged a warning reading `failed=0`.
   */
  summarize(line: string): void;
}

export interface SweepResult extends CaptureCounters {
  /** Sessions skipped because Barry hosted them. */
  hostedSkipped: number;
  /** Sessions whose adapter has no reader in this deployment. */
  noReader: number;
  /**
   * Sessions that threw partway through.
   *
   * Counted because `located` and `persisted` cannot show it. `persisted` is a
   * ROW count, not a session count, so a sweep where most sessions store
   * thousands of rows and a subset stores none reads exactly like a healthy
   * one: `considered=11 located=11 persisted=3176` was true while TEN sessions
   * were failing every cycle on an uninitialised sequence. The per-session
   * error went to a separate log line nobody correlates with the summary.
   */
  failed: number;
}

/**
 * One sweep.
 *
 * Returns counters rather than throwing on a bad session: one unreadable
 * transcript must not end the sweep for every other session, and the counters
 * are how a session that failed becomes visible.
 */
export async function sweepTranscripts(deps: WatcherDeps): Promise<SweepResult> {
  const counters: SweepResult = { ...emptyCounters(), hostedSkipped: 0, noReader: 0, failed: 0 };
  const sessions = await deps.listSessions();

  for (const session of sessions) {
    // A hosted session's capture is the engine's. Reading its file would
    // duplicate rows and make engine completeness look like transcript
    // completeness.
    if (session.host === "hosted") {
      counters.hostedSkipped += 1;
      continue;
    }

    const reader = deps.resolveReader(session.provider);
    if (!reader) {
      // A missing reader for an uninstalled adapter is an ordinary state.
      // Rationale: docs/decisions/0034-adapter-build-capture-and-relay-rationale.md.
      counters.noReader += 1;
      continue;
    }

    counters.considered += 1;

    try {
      const path = await reader.locate({
        harnessSessionId: session.providerSessionId ?? null,
        cwd: session.cwd ?? null,
        ...(session.metadata ? { metadata: session.metadata } : {}),
      });
      if (!path) continue;
      counters.located += 1;

      const scan = await reader.read(path);
      counters.linesRead += scan.linesRead;
      counters.entriesParsed += scan.entriesParsed;

      for (const entry of scan.events) {
        const result = await deps.persist(session.id, entry.key, entry.event);
        switch (result.outcome) {
          case "stored":
            counters.persisted += 1;
            // Counted ALONGSIDE persisted, not instead of it: the row was
            // written, and the claim being tracked is that it carries
            // nothing. Replacing one count with the other would hide how many
            // rows exist.
            if (result.hollow) counters.hollow += 1;
            break;
          case "duplicate":
            counters.dedupeHits += 1;
            break;
          case "skipped":
            if (result.deliberate) {
              counters.skipped += 1;
            } else {
              // An event type the translation has never seen. Reported per
              // occurrence as well as counted, because the TYPE is the thing
              // someone needs in order to fix it.
              counters.unrecognised += 1;
              deps.report(
                `transcript sweep: ${session.id} (${session.provider}) unrecognised event type '${result.eventType}' — not captured`,
              );
            }
            break;
        }
      }
    } catch (err) {
      // Expose capture failures explicitly rather than relying on considered-but-not-persisted counters.
      // Rationale: docs/decisions/0010-adapter-and-session-regression-invariants.md#note-024
      counters.failed += 1;
      deps.report(
        `transcript sweep: ${session.id} (${session.provider}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Summarized every sweep, including a quiet one: a silent sweep cannot be
  // told from one that never ran.
  deps.summarize(
    `transcript sweep: ${summarizeCoverage(counters)} hosted-skipped=${counters.hostedSkipped} no-reader=${counters.noReader} failed=${counters.failed}`,
  );
  for (const alert of assessCoverage(counters)) {
    deps.report(`transcript sweep ALERT (${alert.kind}): ${alert.message}`);
  }

  return counters;
}
