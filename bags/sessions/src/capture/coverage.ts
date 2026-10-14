/** Compare attempted and persisted capture to detect a broken capture path.
 * Rationale: docs/decisions/0033-tracked-capture-and-transport-rationale.md.
 */

export interface CaptureCounters {
  /** Sessions a scan considered. */
  considered: number;
  /** Sessions whose transcript was found. */
  located: number;
  /** Entries handed to the store. */
  persisted: number;
  /**
   * Entries stored whose payload came through EMPTY.
   *
   * Counted separately because `persisted` cannot show it: a row written with
   * no content is a successful write, so a sweep reporting `persisted=3762`
   * looked identical whether those rows held the conversation or an empty
   * envelope. It was the latter — 99.5% of user rows — for as long as the
   * reader's vocabulary went into the store untranslated.
   *
   * A nonzero value here means rows exist but their content does not.
   */
  hollow: number;
  /**
   * Entries carrying nothing to store — a `done` marker, a status change.
   *
   * Expected, and listed by type in `DELIBERATELY_SKIPPED`. Counted so that an
   * UNEXPECTED skip (below) is measured against a known baseline rather than
   * looking like a new failure.
   */
  skipped: number;
  /**
   * Entries whose type this deployment does not recognise.
   *
   * Distinct from `skipped`, and the more serious of the two: it means the
   * vendor emitted something the translation has never seen, so the format has
   * probably moved. Previously these fell off the end of a `switch` with no
   * `default:` and were indistinguishable from an empty transcript.
   */
  unrecognised: number;
  /** Entries already stored — the healthy outcome of a re-read. */
  dedupeHits: number;
  linesRead: number;
  entriesParsed: number;
}

export function emptyCounters(): CaptureCounters {
  return {
    considered: 0,
    located: 0,
    persisted: 0,
    hollow: 0,
    skipped: 0,
    unrecognised: 0,
    dedupeHits: 0,
    linesRead: 0,
    entriesParsed: 0,
  };
}

/**
 * A file this full yielding nothing is a parser problem, not a quiet agent.
 *
 * Below this a zero yield is unremarkable: a transcript that has just been
 * created, or holds only a partial trailing line the vendor is still writing.
 */
export const RATIO_ALERT_MIN_LINES = 20;

export interface CaptureAlert {
  kind: "located-nothing" | "parsed-nothing" | "stored-nothing" | "unrecognised-events";
  message: string;
}

/**
 * Above this share of hollow writes, the store is being filled with rows that
 * carry nothing.
 *
 * Not zero: a single empty assistant message is a real thing an agent can
 * produce. A majority of them is a translation that has stopped working.
 */
export const HOLLOW_ALERT_RATIO = 0.5;

/**
 * What a sweep's counters say is wrong, if anything.
 *
 * Returns alerts rather than throwing or logging: the caller decides whether a
 * sweep that found nothing is worth waking someone over, and a pure function is
 * what lets a test assert the judgement without a store.
 */
export function assessCoverage(counters: CaptureCounters): CaptureAlert[] {
  const alerts: CaptureAlert[] = [];

  // Considered sessions but located none: every path is wrong, or the vendor
  // moved its directory. One session with no transcript is ordinary; all of
  // them is a configuration fault.
  if (counters.considered > 0 && counters.located === 0) {
    alerts.push({
      kind: "located-nothing",
      message: `no transcript located for any of ${counters.considered} session(s) — the search path is probably wrong, not the sessions quiet`,
    });
  }

  // A substantial file that parses to nothing.
  if (counters.linesRead >= RATIO_ALERT_MIN_LINES && counters.entriesParsed === 0) {
    alerts.push({
      kind: "parsed-nothing",
      message: `read ${counters.linesRead} lines and parsed 0 entries — the reader has probably stopped understanding this vendor's format`,
    });
  }

  // Rows are being written, but they carry nothing. This is the state that
  // held in production undetected: every other counter healthy, the content
  // gone. Judged on the rows actually written, so a sweep with nothing to do
  // cannot trip it.
  if (counters.persisted > 0 && counters.hollow / counters.persisted > HOLLOW_ALERT_RATIO) {
    const pct = Math.round((100 * counters.hollow) / counters.persisted);
    alerts.push({
      kind: "stored-nothing",
      message: `${counters.hollow} of ${counters.persisted} stored rows (${pct}%) have an EMPTY payload — the rows exist but the content does not; the reader's events are probably not reaching the store's fields`,
    });
  }

  // An event type the translation has never seen. One is enough to report: it
  // means the vendor's format moved, and every such event is silently absent
  // from the capture.
  if (counters.unrecognised > 0) {
    alerts.push({
      kind: "unrecognised-events",
      message: `${counters.unrecognised} entr${counters.unrecognised === 1 ? "y" : "ies"} had an unrecognised event type — this vendor's format has probably changed and those entries were not captured`,
    });
  }

  return alerts;
}

/**
 * One line summarising a sweep.
 *
 * Printed even when nothing happened, because a silent sweep cannot be told
 * from one that never ran.
 */
export function summarizeCoverage(counters: CaptureCounters): string {
  return [
    `considered=${counters.considered}`,
    `located=${counters.located}`,
    `persisted=${counters.persisted}`,
    // Always printed, including the healthy `hollow=0`: a field that appears
    // only when it is nonzero cannot be told from one nobody is computing.
    `hollow=${counters.hollow}`,
    `skipped=${counters.skipped}`,
    `unrecognised=${counters.unrecognised}`,
    `deduped=${counters.dedupeHits}`,
    `lines=${counters.linesRead}/${counters.entriesParsed}`,
  ].join(" ");
}
