/**
 * Reading what a harness wrote to disk, for sessions Barry did not host.
 *
 * Harness transcripts are unstable by their vendors' own word, so a reader is
 * expected to break on an upgrade. The counters are how that breakage becomes
 * visible instead of looking like a quiet session.
 */
import type { SessionEvent } from "../sessions/index.js";

export interface TranscriptSession {
  harnessSessionId?: string | null;
  cwd?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TranscriptSource {
  /** Allowed locations for recorded transcript reads. Callers must realpath both root and file.
   * Absence is not unrestricted access: authorization-dependent reads must fail closed.
   */
  roots?(session: TranscriptSession): Promise<readonly string[]>;
  /** `null` is an ordinary answer: a hosted session has no file, a new one has none yet. */
  locate(session: TranscriptSession): Promise<string | null>;
  /**
   * `since` is the last key persisted. A reader may skip work with it but need
   * not: keys make re-reading safe, so correctness never depends on the cursor.
   */
  read(path: string, since?: string): Promise<TranscriptScan>;
}

export interface TranscriptScan {
  events: TranscriptEvent[];
  /**
   * Both counts, because their ratio is the signal: a thousand lines yielding
   * no entries is a reader that stopped understanding its format.
   */
  linesRead: number;
  entriesParsed: number;
}

export interface TranscriptEvent {
  /** Stable across re-reads — a key derived from read order would make every pass look new. */
  key: string;
  event: SessionEvent;
}
