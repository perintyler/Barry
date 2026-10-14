// Resume by byte offset and preserve incomplete trailing lines for the next ingest.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-067

import type Database from "better-sqlite3";
import { statSync } from "node:fs";

export type Db = Database.Database;

// Report both inspected and inserted rows so deduplication differs from an idle ingest.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-068
export interface IngestResult {
  read: number;
  inserted: number;
}

/** Stored byte offset for a file, or 0 if this file has never been ingested. */
export function getFileOffset(db: Db, file: string): number {
  const row = db
    .prepare("SELECT offset FROM file_offset WHERE file = ?")
    .get(file) as { offset: number } | undefined;
  return row?.offset ?? 0;
}

export function setFileOffset(db: Db, file: string, offset: number): void {
  db.prepare(
    "INSERT INTO file_offset (file, offset) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset",
  ).run(file, offset);
}

// A saved offset belongs to the file generation; truncation requires restarting it.
// Rationale: docs/decisions/0004-telemetry-extension-and-alert-invariants.md#note-069
export function resolveStartOffset(stored: number, sizeBytes: number): number {
  if (!Number.isInteger(stored) || stored < 0) return 0;
  if (stored > sizeBytes) return 0;
  return stored;
}

/** Size of a log file in MB, for reporting proximity to the truncation limit. */
export function logSizeMb(file: string): number | undefined {
  try {
    return statSync(file).size / 1_048_576;
  } catch {
    return undefined;
  }
}
